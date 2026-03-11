import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const MAX_FILES = 500;
const MAX_BYTES_PER_FILE = 512 * 1024;
const execFile = promisify(execFileCb);

const SECRET_PATTERNS = [
  {
    id: 'openai-api-key',
    regex: /\bsk-[A-Za-z0-9]{20,}\b/g,
    title: 'Potential OpenAI API key in plaintext',
    severity: 'critical',
    reason:
      'A valid OpenAI API key can be abused for impersonation, billing theft, and model misuse.',
    remediationLink:
      'https://docs.github.com/en/code-security/secret-scanning/secret-scanning-patterns'
  },
  {
    id: 'github-token',
    regex: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
    title: 'Potential GitHub token in plaintext',
    severity: 'critical',
    reason: 'GitHub tokens can grant repository read/write access and supply chain control.',
    remediationLink:
      'https://docs.github.com/en/code-security/secret-scanning/secret-scanning-patterns'
  },
  {
    id: 'slack-token',
    regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    title: 'Potential Slack token in plaintext',
    severity: 'high',
    reason: 'Slack tokens can expose conversations, files, and automation workflows.',
    remediationLink: 'https://api.slack.com/authentication/token-types'
  },
  {
    id: 'aws-access-key',
    regex: /\bAKIA[0-9A-Z]{16}\b/g,
    title: 'Potential AWS access key in plaintext',
    severity: 'critical',
    reason: 'AWS access keys can allow unauthorized cloud access and privilege abuse.',
    remediationLink:
      'https://docs.aws.amazon.com/general/latest/gr/aws-access-keys-best-practices.html'
  },
  {
    id: 'jwt-token',
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    title: 'Potential JWT token in plaintext',
    severity: 'high',
    reason: 'Leaked JWTs can be replayed to impersonate authenticated users or services.',
    remediationLink: 'https://owasp.org/www-project-api-security/'
  },
  {
    id: 'private-key-block',
    regex:
      /-----BEGIN (?:RSA PRIVATE KEY|OPENSSH PRIVATE KEY|EC PRIVATE KEY|PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----/g,
    title: 'Potential private key material in plaintext',
    severity: 'critical',
    reason: 'Private keys can be used for account takeover, signing abuse, and decryption.',
    remediationLink: 'https://trufflesecurity.com/blog/how-trufflehog-works'
  },
  {
    id: 'db-connection-string',
    regex: /\b(?:postgres(?:ql)?|mongodb(?:\+srv)?|redis):\/\/[^\s'"`]+:[^\s'"`]+@[^\s'"`]+/g,
    title: 'Potential database connection string with credentials',
    severity: 'high',
    reason: 'Embedded database credentials can expose production data and control planes.',
    remediationLink: 'https://owasp.org/www-project-api-security/'
  },
  {
    id: 'gcp-api-key',
    regex: /\bAIza[0-9A-Za-z\-_]{35}\b/g,
    title: 'Potential Google Cloud API key in plaintext',
    severity: 'high',
    reason: 'GCP API keys may allow unauthorized access to enabled Google APIs.',
    remediationLink:
      'https://docs.github.com/en/code-security/secret-scanning/secret-scanning-patterns'
  },
  {
    id: 'azure-storage-key',
    regex: /\bAccountKey=[A-Za-z0-9+/]{40,}={0,2}\b/g,
    title: 'Potential Azure storage account key in plaintext',
    severity: 'critical',
    reason: 'Azure storage keys can provide full data plane access for the account.',
    remediationLink:
      'https://learn.microsoft.com/en-us/azure/storage/common/storage-account-keys-manage'
  },
  {
    id: 'digitalocean-token',
    regex: /\bdop_v1_[A-Za-z0-9]{60,}\b/g,
    title: 'Potential DigitalOcean API token in plaintext',
    severity: 'high',
    reason: 'DigitalOcean tokens can grant management access to infrastructure resources.',
    remediationLink:
      'https://docs.github.com/en/code-security/secret-scanning/secret-scanning-patterns'
  },
  {
    id: 'discord-webhook-url',
    regex: /https:\/\/discord(?:app)?\.com\/api\/webhooks\/[0-9]+\/[A-Za-z0-9_-]+/g,
    title: 'Potential Discord webhook URL in plaintext',
    severity: 'medium',
    reason: 'Webhook URLs can be abused to send unauthorized messages and spam.',
    remediationLink: 'https://discord.com/developers/docs/resources/webhook'
  },
  {
    id: 'slack-webhook-url',
    regex: /https:\/\/hooks\.slack\.com\/services\/[A-Z0-9]+\/[A-Z0-9]+\/[A-Za-z0-9]+/g,
    title: 'Potential Slack webhook URL in plaintext',
    severity: 'medium',
    reason: 'Leaked Slack webhooks can be used to post unauthorized content in channels.',
    remediationLink: 'https://api.slack.com/messaging/webhooks'
  },
  {
    id: 'generic-webhook-url',
    regex: /https?:\/\/[^\s'"`]*webhook[^\s'"`]*/gi,
    title: 'Potential generic webhook URL in plaintext',
    severity: 'low',
    reason: 'Hardcoded webhook endpoints can reveal integration surfaces and secrets.',
    remediationLink: 'https://owasp.org/www-project-api-security/'
  },
  {
    id: 'dotenv-secret-assignment',
    regex:
      /\b(?:API(?:_|-)?KEY|SECRET|TOKEN|PASSWORD|ACCESS(?:_|-)?KEY|PRIVATE(?:_|-)?KEY)\s*=\s*[^\s#]+/gi,
    title: 'Potential .env style secret assignment in plaintext',
    severity: 'high',
    reason: 'Hardcoded secrets in environment-style assignments are commonly exploitable.',
    remediationLink: 'https://12factor.net/config'
  },
  {
    id: 'hardcoded-bearer-token',
    regex: /\bAuthorization\b\s*[:=]\s*['"]Bearer\s+[A-Za-z0-9\-._~+/]+=*['"]/gi,
    title: 'Potential hardcoded bearer token in headers',
    severity: 'high',
    reason: 'Bearer tokens provide direct delegated access and are reusable when leaked.',
    remediationLink: 'https://www.rfc-editor.org/rfc/rfc6750'
  },
  {
    id: 'stripe-api-key',
    regex: /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
    title: 'Potential Stripe API key in plaintext',
    severity: 'critical',
    reason: 'Stripe API keys can expose billing operations and payment data.',
    remediationLink:
      'https://docs.github.com/en/code-security/secret-scanning/secret-scanning-patterns'
  },
  {
    id: 'twilio-api-key',
    regex: /\bSK[0-9a-fA-F]{32}\b/g,
    title: 'Potential Twilio API key in plaintext',
    severity: 'high',
    reason: 'Twilio keys can be abused to send SMS/voice traffic and access customer data.',
    remediationLink:
      'https://docs.github.com/en/code-security/secret-scanning/secret-scanning-patterns'
  },
  {
    id: 'sendgrid-api-key',
    regex: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g,
    title: 'Potential SendGrid API key in plaintext',
    severity: 'high',
    reason: 'SendGrid keys can be used for phishing/spam and account compromise.',
    remediationLink:
      'https://docs.github.com/en/code-security/secret-scanning/secret-scanning-patterns'
  }
];

const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage']);

const toRelative = (rootPath, absolutePath) => path.relative(rootPath, absolutePath) || '.';
const toPosixRelative = (rootPath, absolutePath) =>
  toRelative(rootPath, absolutePath).split(path.sep).join('/');

const addFinding = (findings, finding) => {
  findings.push({
    id: `finding-${findings.length + 1}`,
    ...finding
  });
};

const listFiles = async (rootPath) => {
  const queue = [rootPath];
  const files = [];

  while (queue.length > 0 && files.length < MAX_FILES) {
    const current = queue.shift();
    const entries = await readdir(current, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name.startsWith('.DS_Store')) {
        continue;
      }

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

const parseNullDelimited = (value) => value.split('\0').filter(Boolean);

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
  const sorted = [...workspaceFiles].sort((left, right) =>
    toPosixRelative(rootPath, left).localeCompare(toPosixRelative(rootPath, right))
  );

  return sorted;
};

const readSafeText = async (filePath) => {
  const content = await readFile(filePath);

  if (content.byteLength > MAX_BYTES_PER_FILE) {
    return null;
  }

  return content.toString('utf8');
};

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

const hasSecurityDoc = (files) =>
  files.some((filePath) => path.basename(filePath).toLowerCase() === 'security.md');

const hasLockfile = (files) =>
  files.some((filePath) => LOCKFILE_NAMES.has(path.basename(filePath).toLowerCase()));

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

const scanFileForPatterns = ({ findings, rootPath, filePath, text }) => {
  const relPath = toRelative(rootPath, filePath);

  for (const pattern of SECRET_PATTERNS) {
    pattern.regex.lastIndex = 0;
    for (const matched of text.matchAll(pattern.regex)) {
      const context = getLineContext(text, matched.index ?? 0);
      addFinding(findings, {
        title: pattern.title,
        category: 'exposed-secrets',
        severity: pattern.severity,
        reason: pattern.reason,
        matchedPattern: pattern.id,
        remediationLink: pattern.remediationLink,
        evidenceSnippet: `${relPath}:${context.line}: ${context.lineText}`,
        file: relPath,
        line: context.line
      });
    }
  }
};

const dedupeFindings = (findings) => {
  const seen = new Set();
  return findings.filter((finding) => {
    const key = `${finding.title}:${finding.evidenceSnippet}`;
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
};

export const runProbes = async ({ targetPath, includeUntracked = false, scope = 'tracked' }) => {
  const findings = [];
  const includeWorkspaceFiles = scope === 'workspace';
  const files = await selectScanFiles({
    rootPath: targetPath,
    includeUntracked: includeUntracked || includeWorkspaceFiles
  });

  if (!hasSecurityDoc(files)) {
    addFinding(findings, {
      title: 'Missing SECURITY documentation',
      category: 'security-docs',
      severity: 'low',
      reason: 'No SECURITY.md was found in scanned workspace.',
      evidenceSnippet: 'SECURITY.md not found'
    });
  }

  if (!hasLockfile(files)) {
    addFinding(findings, {
      title: 'Missing dependency lockfile',
      category: 'dependency-hygiene',
      severity: 'low',
      reason: 'No recognized dependency lockfile was found in scanned workspace.',
      evidenceSnippet: 'No lockfile detected (e.g. package-lock.json, yarn.lock, pnpm-lock.yaml).'
    });
  }

  const raw = [];
  for (const filePath of files) {
    const text = await readSafeText(filePath);
    if (!text) {
      continue;
    }

    const beforeCount = findings.length;
    scanFileForPatterns({ findings, rootPath: targetPath, filePath, text });
    const fileFindings = findings.length - beforeCount;

    raw.push({
      file: toPosixRelative(targetPath, filePath),
      findings: fileFindings
    });
  }

  return {
    findings: dedupeFindings(findings),
    raw,
    metadata: {
      scanned_files: files.length
    }
  };
};
