import { readdir, readFile } from 'node:fs/promises';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { SCAN_FOCUS_OPTIONS, normalizeScanFocusValues } from './scanFocus.mjs';

const execFile = promisify(execFileCb);

const MAX_FILES = 500;
const MAX_BYTES_PER_FILE = 512 * 1024;
const LOCKFILE_NAMES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'poetry.lock',
  'pipfile.lock',
  'cargo.lock',
  'go.sum',
  'gemfile.lock',
  'composer.lock',
  'uv.lock'
]);
const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage']);
const DEFAULT_FOCUS = SCAN_FOCUS_OPTIONS.map((option) => option.value);

const SECRET_PATTERNS = [
  { regex: /\bsk-[A-Za-z0-9]{20,}\b/g, title: 'Potential OpenAI API key in plaintext' },
  { regex: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, title: 'Potential GitHub token in plaintext' },
  { regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, title: 'Potential Slack token in plaintext' },
  { regex: /\bAKIA[0-9A-Z]{16}\b/g, title: 'Potential AWS access key in plaintext' }
];

const REPO_RISK_PATTERNS = [
  { regex: /curl\s+[^\n]*\|\s*(sh|bash)/gi, title: 'Pipe-to-shell command detected' },
  { regex: /\brm\s+-rf\s+\//gi, title: 'Destructive root delete command detected' },
  { regex: /\bchmod\s+777\b/gi, title: 'Overly permissive chmod command detected' }
];

const toPosixRelative = (rootPath, absolutePath) =>
  (path.relative(rootPath, absolutePath) || '.').split(path.sep).join('/');

const getLineContext = (text, index) => {
  const prefix = text.slice(0, index);
  const line = prefix.split('\n').length;
  const lineStart = prefix.lastIndexOf('\n') + 1;
  const nextLineBreak = text.indexOf('\n', index);
  const lineEnd = nextLineBreak === -1 ? text.length : nextLineBreak;

  return {
    line,
    lineText: text.slice(lineStart, lineEnd).trim()
  };
};

const parseNullDelimited = (value) => value.split('\0').filter(Boolean);

const listFiles = async (rootPath) => {
  const queue = [rootPath];
  const files = [];

  while (queue.length > 0 && files.length < MAX_FILES) {
    const current = queue.shift();
    const entries = await readdir(current, { withFileTypes: true });

    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) {
          queue.push(absolutePath);
        }
        continue;
      }

      if (entry.isFile()) {
        files.push(absolutePath);
      }

      if (files.length >= MAX_FILES) {
        break;
      }
    }
  }

  return files;
};

const getGitSelectedFiles = async ({ rootPath, includeUntracked }) => {
  try {
    const trackedResult = await execFile('git', [
      '-C',
      rootPath,
      'ls-files',
      '-z',
      '--cached',
      '--',
      '.'
    ]);
    const tracked = parseNullDelimited(trackedResult.stdout);
    const selected = [...tracked];

    if (includeUntracked) {
      const untrackedResult = await execFile('git', [
        '-C',
        rootPath,
        'ls-files',
        '-z',
        '--others',
        '--exclude-standard',
        '--',
        '.'
      ]);
      selected.push(...parseNullDelimited(untrackedResult.stdout));
    }

    const deduped = Array.from(new Set(selected));
    deduped.sort((left, right) => left.localeCompare(right));

    return deduped.map((relPath) => path.resolve(rootPath, relPath));
  } catch {
    return null;
  }
};

const selectScanFiles = async ({ rootPath, includeUntracked }) => {
  const gitFiles = await getGitSelectedFiles({ rootPath, includeUntracked });
  if (gitFiles) {
    return gitFiles;
  }

  const workspaceFiles = await listFiles(rootPath);
  return [...workspaceFiles].sort((left, right) =>
    toPosixRelative(rootPath, left).localeCompare(toPosixRelative(rootPath, right))
  );
};

const readSafeText = async (filePath) => {
  const content = await readFile(filePath);
  if (content.byteLength > MAX_BYTES_PER_FILE) {
    return null;
  }
  return content.toString('utf8');
};

const buildFinding = (finding, findings) => ({ id: `finding-${findings.length + 1}`, ...finding });

const hasSecurityDoc = (files) =>
  files.some((filePath) => path.basename(filePath).toLowerCase() === 'security.md');

const hasLockfile = (files) =>
  files.some((filePath) => LOCKFILE_NAMES.has(path.basename(filePath).toLowerCase()));

function resolveQuickScanFocus(focusValues) {
  const normalized = normalizeScanFocusValues(focusValues);
  return normalized.length > 0 ? normalized : DEFAULT_FOCUS;
}

export async function runLocalQuickScan({
  workspacePath,
  includeUntracked = false,
  scope = 'tracked',
  focus = []
}) {
  const appliedFocus = resolveQuickScanFocus(focus);
  const includeWorkspaceFiles = scope === 'workspace';
  const files = await selectScanFiles({
    rootPath: workspacePath,
    includeUntracked: includeUntracked || includeWorkspaceFiles
  });

  const findings = [];
  const raw = [];

  if (appliedFocus.includes('security_md_presence') && !hasSecurityDoc(files)) {
    findings.push(
      buildFinding(
        {
          focus: 'security_md_presence',
          title: 'Missing SECURITY documentation',
          severity: 'low',
          reason: 'No SECURITY.md was found in scanned workspace.',
          evidence: 'SECURITY.md not found'
        },
        findings
      )
    );
  }

  if (appliedFocus.includes('lockfile_hygiene') && !hasLockfile(files)) {
    findings.push(
      buildFinding(
        {
          focus: 'lockfile_hygiene',
          title: 'Missing dependency lockfile',
          severity: 'low',
          reason: 'No recognized dependency lockfile was found in scanned workspace.',
          evidence: 'No lockfile detected (e.g. package-lock.json, yarn.lock, pnpm-lock.yaml).'
        },
        findings
      )
    );
  }

  for (const filePath of files) {
    const text = await readSafeText(filePath);
    if (!text) continue;

    const fileRelPath = toPosixRelative(workspacePath, filePath);
    const fileFindingCountBefore = findings.length;

    if (appliedFocus.includes('secrets_detection')) {
      for (const pattern of SECRET_PATTERNS) {
        pattern.regex.lastIndex = 0;
        for (const match of text.matchAll(pattern.regex)) {
          const context = getLineContext(text, match.index ?? 0);
          findings.push(
            buildFinding(
              {
                focus: 'secrets_detection',
                title: pattern.title,
                severity: 'critical',
                reason: 'Secret-like token pattern detected in file contents.',
                file: fileRelPath,
                line: context.line,
                evidence: `${fileRelPath}:${context.line}: ${context.lineText}`
              },
              findings
            )
          );
        }
      }
    }

    if (appliedFocus.includes('repo_risk_signals')) {
      for (const pattern of REPO_RISK_PATTERNS) {
        pattern.regex.lastIndex = 0;
        for (const match of text.matchAll(pattern.regex)) {
          const context = getLineContext(text, match.index ?? 0);
          findings.push(
            buildFinding(
              {
                focus: 'repo_risk_signals',
                title: pattern.title,
                severity: 'medium',
                reason: 'Potentially unsafe shell command found in repository text.',
                file: fileRelPath,
                line: context.line,
                evidence: `${fileRelPath}:${context.line}: ${context.lineText}`
              },
              findings
            )
          );
        }
      }
    }

    if (appliedFocus.includes('dependency_risk') && path.basename(filePath) === 'package.json') {
      try {
        const packageJson = JSON.parse(text);
        const dependencyBlocks = [
          'dependencies',
          'devDependencies',
          'peerDependencies',
          'optionalDependencies'
        ];

        for (const blockName of dependencyBlocks) {
          const block = packageJson?.[blockName];
          if (!block || typeof block !== 'object') {
            continue;
          }

          for (const [name, version] of Object.entries(block)) {
            if (typeof version !== 'string') continue;
            const normalizedVersion = version.trim();
            if (
              /^(\*|latest)$/i.test(normalizedVersion) ||
              /^https?:\/\//i.test(normalizedVersion) ||
              /^github:/i.test(normalizedVersion)
            ) {
              findings.push(
                buildFinding(
                  {
                    focus: 'dependency_risk',
                    title: `High-risk dependency pinning for ${name}`,
                    severity: 'medium',
                    reason: 'Dependency uses non-deterministic or remote source version.',
                    file: fileRelPath,
                    evidence: `${name}@${normalizedVersion}`
                  },
                  findings
                )
              );
            }
          }
        }
      } catch {
        // ignore malformed package json
      }
    }

    raw.push({ file: fileRelPath, findings: findings.length - fileFindingCountBefore });
  }

  return {
    focus: appliedFocus,
    findings,
    raw,
    metadata: {
      scanned_files: files.length
    }
  };
}
