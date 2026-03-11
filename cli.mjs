#!/usr/bin/env node

import { realpathSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import process from 'node:process';
import path from 'node:path';
import {
  DEFAULT_SCAN_POLL_MAX_WAIT_MS,
  DEFAULT_SCAN_POLL_RETRY_AFTER_MS
} from './src/constants/scanPolling.js';
import { normalizeScanFocusValues } from './src/scanFocus.mjs';
import { runLocalQuickScan } from './src/localQuickScanner.mjs';
import { adapterRegistry, runAdapterScan } from './src/adapters/ScanOrchestrator.mjs';
import { execFileSync } from 'node:child_process';

const DEFAULT_BASE_URL = 'https://moltbench.vercel.app';

// ── Credential paths ────────────────────────────────────────────────

function agentKeyPath() {
  if (globalThis.process.env.MOLTBENCH_AGENT_KEY_PATH) {
    return globalThis.process.env.MOLTBENCH_AGENT_KEY_PATH;
  }
  return path.join(homedir(), '.moltbench', 'agent.json');
}

function cliStatePath() {
  return path.join(homedir(), '.moltbench', 'cli-state.json');
}

// ── Credential helpers ──────────────────────────────────────────────

async function loadAgentCredential() {
  const configPath = agentKeyPath();
  let raw;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch {
    throw new Error(
      `No saved agent key found at ${configPath}. Run "moltbench agent pair --code <pairing-code>" first.`
    );
  }
  const parsed = JSON.parse(raw);
  if (!parsed?.apiKey) {
    throw new Error(
      `Saved agent credential at ${configPath} is invalid. Run "moltbench agent pair --code <pairing-code>" again.`
    );
  }
  return { ...parsed, configPath };
}

function saveAgentCredential(data) {
  const filePath = agentKeyPath();
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2));
}

async function loadCliState() {
  const statePath = cliStatePath();
  let state = {};
  try {
    state = JSON.parse(readFileSync(statePath, 'utf8'));
  } catch {
    // no state yet
  }
  return { statePath, state };
}

async function saveCliState(statePath, state) {
  mkdirSync(path.dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

// ── Default confirm (stdin) ─────────────────────────────────────────

async function defaultConfirm(prompt) {
  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'yes');
    });
  });
}

// ── Usage ───────────────────────────────────────────────────────────

const AGENT_CREDENTIAL_WARNING =
  '\n⚠️  This is a delegated agent credential. Store it securely.\n' +
  'The API key is shown ONCE. If lost, rotate with "moltbench agent rotate".';

function printUsage(io) {
  io.log(
    `MoltBench CLI\n\nUsage:\n` +
      `  moltbench scan capabilities [--base-url <url>] [--json]\n` +
      `  moltbench scan adapters [--install-missing] [--json]\n` +
      `  moltbench scan init [--focus <focus-a,focus-b>] [--base-url <url>] [--json]
` +
      `  moltbench scan status <scanId> [--base-url <url>] [--json]\n` +
      `  moltbench scan results <scanId> [--base-url <url>] [--json]
  moltbench scan list [--limit <n>] [--base-url <url>] [--json]
` +
      `  moltbench scan quick --workspace <path> [--include-untracked] [--scope <tracked|workspace>] [--focus <focus-a,focus-b>] [--submit] [--json]
` +
      `  moltbench agent pair --code <pairing-code> [--base-url <url>] [--json]\n` +
      `  moltbench agent rotate [--base-url <url>] [--json]\n` +
      `  moltbench agent revoke [--base-url <url>] [--json]\n` +
      `  moltbench agent attest (--run-id <runId> | --audit-id <auditId>) [--moltbench-user-id <userId>] [--resubmit] [--yes] [--base-url <url>] [--json]`
  );
}

function printSubcommandUsage(io, domain, subcommand) {
  const usage = {
    'scan.capabilities': 'moltbench scan capabilities [--base-url <url>] [--json]',
    'scan.adapters': 'moltbench scan adapters [--install-missing] [--json]',
    'scan.init':
      'moltbench scan init [--mode <hosted|local>] [--target <path-or-url>] [--adapters <id,id>] [--install-missing] [--focus <focus-a,focus-b>] [--base-url <url>] [--json]',
    'scan.status': 'moltbench scan status <scanId> [--base-url <url>] [--json]',
    'scan.results': 'moltbench scan results <scanId> [--base-url <url>] [--json]',
    'scan.list': 'moltbench scan list [--limit <n>] [--base-url <url>] [--json]',
    'scan.quick':
      'moltbench scan quick --workspace <path> [--include-untracked] [--scope <tracked|workspace>] [--focus <focus-a,focus-b>] [--submit] [--json]',
    'agent.pair': 'moltbench agent pair --code <pairing-code> [--base-url <url>] [--json]',
    'agent.rotate': 'moltbench agent rotate [--base-url <url>] [--json]',
    'agent.revoke': 'moltbench agent revoke [--base-url <url>] [--json]',
    'agent.attest':
      'moltbench agent attest (--run-id <runId> | --audit-id <auditId>) [--moltbench-user-id <userId>] [--resubmit] [--yes] [--base-url <url>] [--json]'
  };

  const key = `${domain}.${subcommand}`;
  if (usage[key]) {
    io.log(`Usage:
  ${usage[key]}`);
    return;
  }

  printUsage(io);
}

// ── Arg parsing ─────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = [...argv];
  const json = args.includes('--json');
  const pretty = args.includes('--pretty');
  let filtered = args.filter((a) => a !== '--json' && a !== '--pretty');

  let baseUrl = DEFAULT_BASE_URL;
  const baseUrlIndex = filtered.indexOf('--base-url');
  if (baseUrlIndex !== -1) {
    if (!filtered[baseUrlIndex + 1]) throw new Error('Missing value for --base-url');
    baseUrl = filtered[baseUrlIndex + 1];
    filtered.splice(baseUrlIndex, 2);
  }

  return { filtered, json, pretty, baseUrl: baseUrl.replace(/\/$/, '') };
}

function consumeFlag(args, flag) {
  const idx = args.indexOf(flag);
  if (idx === -1) return false;
  args.splice(idx, 1);
  return true;
}

function parseFocusFlagValue(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return [];
  }

  const splitValues = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return normalizeScanFocusValues(splitValues);
}

function consumeValueFlag(args, flag) {
  const idx = args.indexOf(flag);
  if (idx === -1) return null;
  const val = args[idx + 1] ?? null;
  args.splice(idx, val !== null ? 2 : 1);
  return val;
}

// ── Response helpers ────────────────────────────────────────────────

async function parseJsonBody(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return { raw: text };
  }
}

const wait = (ms) =>
  new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });

const normalizePollingHint = (value, fallback) => {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return fallback;
  }

  return Math.max(100, Math.round(value));
};

async function requestWithPolling(endpoint, requestInit, label) {
  const startedAt = Date.now();
  let delayMs = DEFAULT_SCAN_POLL_RETRY_AFTER_MS;
  let maxWaitMs = DEFAULT_SCAN_POLL_MAX_WAIT_MS;

  while (Date.now() - startedAt <= maxWaitMs) {
    const response = await globalThis.fetch(endpoint, requestInit);
    const payload = await parseJsonBody(response);

    if (response.ok) {
      return payload;
    }

    if (response.status !== 425) {
      const message =
        typeof payload === 'object' && payload
          ? (payload.error ?? payload.message ?? JSON.stringify(payload))
          : String(payload);
      throw new Error(`Request failed (${response.status} ${response.statusText}): ${message}`);
    }

    const hintedDelayMs = normalizePollingHint(payload?.retryAfterMs, delayMs);
    delayMs = Math.max(delayMs, hintedDelayMs);
    maxWaitMs = normalizePollingHint(payload?.maxWaitMs, maxWaitMs);

    if (Date.now() - startedAt + delayMs > maxWaitMs) {
      const progressStamp = payload?.lastProgressAt ?? 'unknown';
      throw new Error(
        `${label} timed out after ${maxWaitMs}ms. Last progress update: ${progressStamp}.`
      );
    }

    await wait(delayMs);
    delayMs = Math.min(Math.round(delayMs * 2), 5000);
  }

  throw new Error(`${label} timed out after ${maxWaitMs}ms.`);
}

function formatCapabilities(payload) {
  const lines = [];
  lines.push(`deployment_mode: ${payload.deployment_mode ?? 'unknown'}`);
  const allowed = payload.tier1_routes?.allowed ?? [];
  lines.push(`tier1_allowed_routes: ${allowed.join(', ') || 'none'}`);
  const gated =
    payload.auth_requirements?.gated_modes?.requires_authenticated_moltbench_user_id ?? [];
  lines.push(`gated_modes_require_human_context: ${gated.join(', ') || 'none'}`);
  lines.push('');
  lines.push('Available MCP tool routes:');
  lines.push('  - /api/mcp/tools/scan.initiate');
  lines.push('  - /api/mcp/tools/scan.status');
  lines.push('  - /api/mcp/tools/scan.results');
  return lines.join('\n');
}

function formatResults(payload) {
  const artifact = payload.scan_artifact ?? {};
  const lines = [];

  // metadata line
  const source = artifact.static_scan?.source ?? 'unknown';
  const files = artifact.static_scan?.scanned_files ?? 0;
  lines.push(`metadata: source=${source}, scanned_files=${files}`);

  // gate + score
  lines.push(`gate: ${artifact.gate_result ?? 'unknown'}`);
  lines.push(`score: ${artifact.score ?? 'unknown'}`);

  // findings
  const findings = artifact.findings ?? [];
  if (findings.length > 0) {
    lines.push('');
    lines.push('findings:');
    for (const f of findings) {
      lines.push(`  - ${f.title ?? 'untitled'}`);
      if (f.local_evidence) {
        lines.push(`    path: ${f.local_evidence.file_path ?? 'unknown'}`);
        if (f.local_evidence.line != null) lines.push(`    line: ${f.local_evidence.line}`);
        if (f.local_evidence.excerpt) lines.push(`    excerpt: ${f.local_evidence.excerpt}`);
      }
    }
  }

  return lines.join('\n');
}

function formatInitResponse(payload) {
  return [
    'Scan initiated.',
    `scanId: ${payload.scanId ?? 'unknown'}`,
    `status: ${payload.status ?? 'unknown'}`
  ].join('\n');
}

function formatStatusResponse(payload) {
  return [
    `scanId: ${payload.scanId ?? 'unknown'}`,
    `state: ${payload.state ?? payload.status ?? 'unknown'}`
  ].join('\n');
}

// ── Hosted summary target ───────────────────────────────────────────

function createHostedSummaryTarget() {
  return {
    type: 'hosted_summary',
    summary: {
      runner_version: 'moltbench-cli@0.1.0',
      schema_version: '1.0',
      generated_at: new Date().toISOString(),
      target: 'runner://moltbench-cli',
      findings: [],
      raw: [],
      provenance: {
        run_id: `moltbench-cli-${Date.now()}`
      }
    }
  };
}

function normalizeAdapterIds(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return [];
  }

  return value
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function installAdapterDependency(adapterId) {
  const installTargets = {
    garak: 'garak',
    agentharm: 'agentharm',
    promptguard: 'promptguard'
  };

  const packageName = installTargets[adapterId];
  if (!packageName) {
    return {
      installed: false,
      message: `No automatic installer configured for ${adapterId}.`
    };
  }

  try {
    execFileSync('python3', ['-m', 'pip', 'install', packageName], { stdio: 'pipe' });
    return { installed: true, message: `Installed ${packageName}.` };
  } catch (error) {
    return {
      installed: false,
      message: error?.stderr ? String(error.stderr).trim() : `Failed to install ${packageName}.`
    };
  }
}

async function resolveAdapterAvailability({ adapterIds, installMissing = false }) {
  const ids = adapterIds.length > 0 ? adapterIds : Object.keys(adapterRegistry);
  const availability = [];

  for (const adapterId of ids) {
    const AdapterClass = adapterRegistry[adapterId];
    if (!AdapterClass) {
      throw new Error(`Unknown adapter id "${adapterId}".`);
    }

    const adapter = new AdapterClass();
    let available = await adapter.isAvailable();
    let installResult = null;

    if (!available && installMissing) {
      installResult = installAdapterDependency(adapterId);
      if (installResult.installed) {
        available = await adapter.isAvailable();
      }
    }

    availability.push({
      adapter: adapterId,
      available,
      ...(installResult ? { install: installResult } : {})
    });
  }

  return availability;
}

function toRedactedHostedFindings(adapterReport) {
  const findings = [];
  for (const adapterResult of adapterReport.adapters ?? []) {
    for (const finding of adapterResult.findings ?? []) {
      findings.push({
        id: finding.id,
        adapter: adapterResult.adapter,
        category: finding.category,
        severity: finding.severity,
        result: finding.result,
        probe: finding.probe
      });
    }
  }
  return findings;
}

function createQuickSubmitTarget(options) {
  const now = Date.now();
  return {
    type: 'hosted_summary',
    summary: {
      runner_version: 'moltbench-cli@0.1.0',
      schema_version: '1.0',
      generated_at: new Date().toISOString(),
      target: 'runner://moltbench-cli/local-quick',
      findings: [],
      raw: [],
      metadata: {
        counts: { findings_total: 0 },
        options: {
          scope: options.scope,
          include_untracked: options.includeUntracked,
          tracked_files_only: options.trackedFilesOnly
        }
      },
      provenance: {
        run_id: `moltbench-cli-local-quick-${now}`,
        nonce: `moltbench-cli-local-quick-${now}`
      }
    }
  };
}

async function resolveWorkspacePath(workspace) {
  return path.resolve(workspace);
}

// ── Main CLI ────────────────────────────────────────────────────────

export async function runCli(
  argv,
  io = { log: globalThis.console.log, error: globalThis.console.error }
) {
  try {
    const { filtered, json, pretty, baseUrl } = parseArgs(argv);

    if (filtered.length === 1 && (filtered[0] === '--help' || filtered[0] === '-h')) {
      printUsage(io);
      return 0;
    }

    if (filtered.length < 2 || !['scan', 'agent'].includes(filtered[0])) {
      printUsage(io);
      return 1;
    }

    const domain = filtered[0];
    const subcommand = filtered[1];
    const rest = filtered.slice(2);

    if (rest.includes('--help') || rest.includes('-h')) {
      printSubcommandUsage(io, domain, subcommand);
      return 0;
    }

    // ── agent commands ────────────────────────────────────────────

    if (domain === 'agent') {
      if (subcommand === 'pair') {
        const code = consumeValueFlag(rest, '--code');
        if (!code) throw new Error('agent pair requires --code <pairing-code>');

        const endpoint = `${baseUrl}/api/agents/pairing/redeem`;
        const response = await globalThis.fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code })
        });
        const payload = await parseJsonBody(response);

        if (!response.ok) {
          io.error(`Pairing failed (${response.status} ${response.statusText})`);
          io.error(
            typeof payload === 'object' && payload && 'error' in payload
              ? payload.error
              : JSON.stringify(payload)
          );
          io.error('Action: request a fresh pairing code and run the pair command again.');
          return 1;
        }

        // Store credential
        saveAgentCredential({
          agentId: payload.agentId,
          keyId: payload.keyId,
          apiKey: payload.apiKey
        });

        if (json) {
          io.log(JSON.stringify(payload));
        } else {
          io.log('Agent paired successfully.');
          io.log(`agentId: ${payload.agentId ?? 'unknown'}`);
          io.log(`keyId: ${payload.keyId ?? 'unknown'}`);
          io.log(`apiKey (one-time): ${payload.apiKey ?? 'missing'}`);
          io.log(`stored_credential: ${agentKeyPath()}`);
          io.log(AGENT_CREDENTIAL_WARNING);
        }
        return 0;
      }

      if (subcommand === 'rotate') {
        const credential = await loadAgentCredential();
        const endpoint = `${baseUrl}/api/agents/keys/rotate`;
        const response = await globalThis.fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${credential.apiKey}`
          },
          body: '{}'
        });
        const payload = await parseJsonBody(response);

        if (!response.ok) {
          io.error(`Rotate failed (${response.status} ${response.statusText})`);
          io.error(
            typeof payload === 'object' && payload && 'error' in payload
              ? payload.error
              : JSON.stringify(payload)
          );
          return 1;
        }

        // Update stored credential
        saveAgentCredential({
          agentId: payload.agentId ?? credential.agentId,
          keyId: payload.keyId,
          apiKey: payload.apiKey
        });

        if (json) {
          io.log(JSON.stringify(payload));
        } else {
          io.log('Agent key rotated successfully.');
          io.log(`agentId: ${payload.agentId ?? 'unknown'}`);
          io.log(`keyId: ${payload.keyId ?? 'unknown'}`);
          io.log(`apiKey (one-time): ${payload.apiKey ?? 'missing'}`);
          io.log(`stored_credential: ${agentKeyPath()}`);
          io.log(AGENT_CREDENTIAL_WARNING);
        }
        return 0;
      }

      if (subcommand === 'revoke') {
        const credential = await loadAgentCredential();
        const endpoint = `${baseUrl}/api/agents/keys/revoke`;
        const response = await globalThis.fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${credential.apiKey}`
          },
          body: '{}'
        });
        const payload = await parseJsonBody(response);

        if (!response.ok) {
          io.error(`Revoke failed (${response.status} ${response.statusText})`);
          io.error(
            typeof payload === 'object' && payload && 'error' in payload
              ? payload.error
              : JSON.stringify(payload)
          );
          return 1;
        }

        if (json) {
          io.log(JSON.stringify(payload));
        } else {
          io.log('Agent key revoked successfully.');
          io.log(`agentId: ${payload?.agentId ?? 'unknown'}`);
          io.log(`keyId: ${payload?.keyId ?? 'unknown'}`);
        }
        return 0;
      }

      if (subcommand === 'attest') {
        // Parse attest-specific flags
        const runId = consumeValueFlag(rest, '--run-id');
        const auditId = consumeValueFlag(rest, '--audit-id');
        const moltbenchUserId = consumeValueFlag(rest, '--moltbench-user-id');
        const resubmit = consumeFlag(rest, '--resubmit');
        const yes = consumeFlag(rest, '--yes');

        if (!runId && !auditId) {
          throw new Error('agent attest requires --run-id <runId> or --audit-id <auditId>');
        }
        const credential = await loadAgentCredential();

        if (!credential.agentId) {
          throw new Error(
            'Saved agent credential is missing agentId. Re-run "moltbench agent pair --code <pairing-code>".'
          );
        }

        // Immutability confirmation
        const { statePath, state } = await loadCliState();
        const hasShownImmutableWarning = state?.attestation_confirmation_seen === true;

        if (!hasShownImmutableWarning) {
          if (!yes) {
            const confirm = io.confirm ?? defaultConfirm;
            const approved = await confirm(
              'On-chain attestations are immutable and permanent. Type "yes" to continue: '
            );
            if (!approved) {
              io.log('Attestation canceled. No on-chain transaction was requested.');
              return 0;
            }
          }
          await saveCliState(statePath, {
            ...state,
            attestation_confirmation_seen: true
          });
        }

        // Build request
        const requestPayload = {};
        if (runId) requestPayload.run_id = runId;
        if (auditId) requestPayload.audit_id = auditId;
        if (resubmit) requestPayload.resubmit = true;

        const endpoint = `${baseUrl}/api/scan/attestation/request`;
        const response = await globalThis.fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${credential.apiKey}`,
            ...(moltbenchUserId ? { 'x-moltbench-user-id': moltbenchUserId.trim() } : {}),
            'x-moltbench-agent-id': credential.agentId
          },
          body: JSON.stringify(requestPayload)
        });
        const payload = await parseJsonBody(response);

        if (!response.ok) {
          io.error(`Attestation failed (${response.status} ${response.statusText})`);
          io.error(
            typeof payload === 'object' && payload && 'error' in payload
              ? payload.error
              : JSON.stringify(payload)
          );
          return 1;
        }

        if (json) {
          io.log(JSON.stringify(payload));
        } else {
          io.log('On-chain attestation requested successfully.');
          io.log(`run_id: ${payload.run_id ?? 'n/a'}`);
          io.log(`audit_id: ${payload.audit_id ?? 'n/a'}`);
          if (payload.attestation?.tx_hash) {
            io.log(`tx_hash: ${payload.attestation.tx_hash}`);
          }
        }
        return 0;
      }

      printUsage(io);
      return 1;
    }

    // ── scan commands ─────────────────────────────────────────────

    if (subcommand === 'capabilities') {
      const endpoint = `${baseUrl}/api/capabilities`;
      const response = await globalThis.fetch(endpoint, { method: 'GET' });
      const payload = await parseJsonBody(response);

      if (!response.ok) {
        io.error(`Request failed (${response.status} ${response.statusText})`);
        io.error(
          typeof payload === 'object' && payload
            ? (payload.error ?? payload.message ?? JSON.stringify(payload))
            : JSON.stringify(payload)
        );
        return 1;
      }

      if (json) {
        io.log(JSON.stringify(payload));
      } else {
        io.log(formatCapabilities(payload));
      }
      return 0;
    }

    if (subcommand === 'adapters') {
      const installMissing = consumeFlag(rest, '--install-missing');
      const availability = await resolveAdapterAvailability({ adapterIds: [], installMissing });
      const payload = { adapters: availability };

      if (json) {
        io.log(JSON.stringify(payload));
      } else {
        for (const adapter of availability) {
          io.log(`${adapter.adapter}: ${adapter.available ? 'available' : 'unavailable'}`);
          if (adapter.install?.message) {
            io.log(`  install: ${adapter.install.message}`);
          }
        }
      }

      return 0;
    }

    if (subcommand === 'quick') {
      const workspace = consumeValueFlag(rest, '--workspace');
      if (!workspace) {
        io.error('scan quick requires --workspace <path>');
        printSubcommandUsage(io, 'scan', 'quick');
        return 1;
      }

      const includeUntracked = consumeFlag(rest, '--include-untracked');
      const scope = consumeValueFlag(rest, '--scope') ?? 'tracked';
      const focusValue = consumeValueFlag(rest, '--focus');
      const focus = parseFocusFlagValue(focusValue);
      const submit = consumeFlag(rest, '--submit');

      const trackedFilesOnly = !includeUntracked;
      const includeWorkspaceScope = scope === 'workspace';
      const resolvedWorkspace = await resolveWorkspacePath(workspace);

      const localScan = await runLocalQuickScan({
        workspacePath: resolvedWorkspace,
        includeUntracked,
        scope,
        focus
      });

      const result = {
        mode: 'local_quick',
        workspace: resolvedWorkspace,
        include_untracked: includeUntracked,
        tracked_files_only: trackedFilesOnly,
        submit,
        scope,
        focus: localScan.focus,
        scan_options: {
          include_untracked: includeUntracked,
          include_workspace_scope: includeWorkspaceScope
        },
        findings: localScan.findings,
        metadata: localScan.metadata,
        raw: localScan.raw
      };

      if (submit) {
        let submitCredential = null;
        try {
          submitCredential = await loadAgentCredential();
        } catch {
          // proceed without auth
        }
        const submitAuthHeaders = submitCredential?.apiKey
          ? { Authorization: `Bearer ${submitCredential.apiKey}` }
          : {};

        const target = createQuickSubmitTarget({
          scope,
          includeUntracked,
          trackedFilesOnly
        });

        const endpoint = `${baseUrl}/api/scan/initiate`;
        const response = await globalThis.fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...submitAuthHeaders },
          body: JSON.stringify({
            mode: 'private_ephemeral',
            target,
            metadata: {
              agent: 'moltbench-cli',
              runLabel: 'local-quick-submit'
            }
          })
        });
        const payload = await parseJsonBody(response);

        if (!response.ok) {
          io.error(`Submit failed (${response.status} ${response.statusText})`);
          io.error(
            typeof payload === 'object' && payload && 'error' in payload
              ? payload.error
              : JSON.stringify(payload)
          );
          return 1;
        }

        result.submission = payload;
      }

      if (json) {
        io.log(JSON.stringify(result));
      } else {
        io.log(`Quick scan completed (${result.workspace})`);
        io.log(`  scope: ${scope}`);
        io.log(`  focus: ${result.focus.join(', ') || 'none'}`);
        io.log(`  include_untracked: ${includeUntracked}`);
        io.log(`  scanned_files: ${result.metadata.scanned_files}`);
        io.log(`  findings: ${result.findings.length}`);
        if (submit) {
          io.log(`  submitted: yes (scanId: ${result.submission?.scanId ?? 'unknown'})`);
        }
      }
      return 0;
    }

    // ── scan init / status / results / list ───────────────────────

    // Try to load credentials for authenticated requests (optional)
    let credential = null;
    try {
      credential = await loadAgentCredential();
    } catch {
      // No credentials stored — proceed without auth
    }

    const authHeaders = credential?.apiKey ? { Authorization: `Bearer ${credential.apiKey}` } : {};

    let endpoint = null;
    let requestInit = { method: 'GET', headers: { ...authHeaders } };

    if (subcommand === 'init') {
      const mode = consumeValueFlag(rest, '--mode') ?? 'hosted';
      const localTarget = consumeValueFlag(rest, '--target');
      const adapterIds = normalizeAdapterIds(consumeValueFlag(rest, '--adapters'));
      const installMissing = consumeFlag(rest, '--install-missing');
      const focusInput = parseFocusFlagValue(consumeValueFlag(rest, '--focus'));

      if (!['hosted', 'local'].includes(mode)) {
        throw new Error('scan init --mode must be either "hosted" or "local"');
      }

      let target = createHostedSummaryTarget();
      if (mode === 'local') {
        if (!localTarget) {
          throw new Error('scan init in local mode requires --target <path-or-url>');
        }

        const availability = await resolveAdapterAvailability({ adapterIds, installMissing });
        const runnableAdapters = availability
          .filter((entry) => entry.available)
          .map((entry) => entry.adapter);

        if (!runnableAdapters.length) {
          throw new Error(
            'No available adapters found for local mode. Run "scan adapters --install-missing" first.'
          );
        }

        const adapterReport = await runAdapterScan({
          target: localTarget,
          enabledAdapters: runnableAdapters
        });

        target = {
          type: 'hosted_summary',
          summary: {
            runner_version: 'moltbench-cli@0.1.0',
            schema_version: '1.0',
            generated_at: new Date().toISOString(),
            target: 'runner://moltbench-cli/local-adapters',
            findings: toRedactedHostedFindings(adapterReport),
            raw: [],
            metadata: {
              mode: 'local',
              target: localTarget,
              adapters_checked: availability,
              adapters_executed: runnableAdapters,
              adapter_errors: adapterReport.errors
            },
            provenance: {
              run_id: `moltbench-cli-local-${Date.now()}`
            }
          }
        };
      } else {
        target.summary.metadata = {
          mode: 'hosted',
          requested_adapters: adapterIds
        };
      }

      endpoint = `${baseUrl}/api/scan/initiate`;
      requestInit = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({
          mode: 'private_ephemeral',
          target,
          metadata: {
            agent: 'moltbench-cli',
            ...(focusInput.length > 0 ? { scan_focus: focusInput } : {})
          }
        })
      };
    } else if (subcommand === 'status') {
      const scanId = rest[0];
      if (!scanId) throw new Error('scan status requires <scanId>');
      endpoint = `${baseUrl}/api/scan/status/${encodeURIComponent(scanId)}`;
    } else if (subcommand === 'results') {
      const scanId = rest[0];
      if (!scanId) throw new Error('scan results requires <scanId>');
      endpoint = `${baseUrl}/api/scan/results/${encodeURIComponent(scanId)}`;
    } else if (subcommand === 'list') {
      const limitRaw = consumeValueFlag(rest, '--limit');
      const limit = limitRaw ? Math.max(1, Number.parseInt(limitRaw, 10) || 20) : 20;
      endpoint = `${baseUrl}/api/scan/list?limit=${encodeURIComponent(String(limit))}`;
    } else {
      printUsage(io);
      return 1;
    }

    let payload;

    try {
      payload =
        subcommand === 'status' || subcommand === 'results'
          ? await requestWithPolling(endpoint, requestInit, `scan ${subcommand}`)
          : await (async () => {
              const response = await globalThis.fetch(endpoint, requestInit);
              const parsed = await parseJsonBody(response);

              if (!response.ok) {
                throw new Error(
                  `Request failed (${response.status} ${response.statusText}): ${
                    typeof parsed === 'object' && parsed
                      ? (parsed.error ?? parsed.message ?? JSON.stringify(parsed))
                      : String(parsed)
                  }`
                );
              }

              return parsed;
            })();
    } catch (requestError) {
      io.error(requestError instanceof Error ? requestError.message : 'Request failed.');
      return 1;
    }

    if (json) {
      io.log(JSON.stringify(payload));
    } else if (pretty) {
      if (subcommand === 'init') {
        io.log(formatInitResponse(payload));
        io.log('\nRaw JSON:');
        io.log(JSON.stringify(payload, null, 2));
      } else if (subcommand === 'status') {
        io.log(formatStatusResponse(payload));
      } else if (subcommand === 'results') {
        io.log(formatResults(payload));
      } else if (subcommand === 'list') {
        io.log(JSON.stringify(payload, null, 2));
      }
    } else {
      // Default human-readable
      if (subcommand === 'init') {
        io.log(formatInitResponse(payload));
      } else if (subcommand === 'status') {
        io.log(formatStatusResponse(payload));
      } else if (subcommand === 'results') {
        io.log(formatResults(payload));
      } else if (subcommand === 'list') {
        const scans = Array.isArray(payload?.scans) ? payload.scans : [];
        io.log(`scan_history_count: ${scans.length}`);
        for (const item of scans) {
          io.log(
            `${item.scanId ?? 'unknown'}  ${item.state ?? 'unknown'}  ${item.createdAt ?? ''}`
          );
        }
      } else {
        io.log(JSON.stringify(payload, null, 2));
      }
    }

    return 0;
  } catch (error) {
    io.error(error instanceof Error ? error.message : 'Unknown CLI error');
    return 1;
  }
}

// ── Entry point (resolves symlinks for npm bin compatibility) ──────

const resolvedArgv = `file://${realpathSync(globalThis.process.argv[1])}`;
if (import.meta.url === resolvedArgv) {
  const code = await runCli(globalThis.process.argv.slice(2));
  globalThis.process.exit(code);
}
