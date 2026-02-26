#!/usr/bin/env node

const DEFAULT_BASE_URL = 'https://moltbench.vercel.app';

function printUsage(io) {
  io.log(
    `MoltBench CLI\n\nUsage:\n  moltbench scan init [--base-url <url>] [--pretty]\n  moltbench scan status <scanId> [--base-url <url>] [--pretty]\n  moltbench scan results <scanId> [--base-url <url>] [--pretty]`
  );
}

function parseArgs(argv) {
  const args = [...argv];
  const pretty = args.includes('--pretty');
  const filtered = args.filter((arg) => arg !== '--pretty');

  let baseUrl = DEFAULT_BASE_URL;
  const baseUrlIndex = filtered.indexOf('--base-url');

  if (baseUrlIndex !== -1) {
    if (!filtered[baseUrlIndex + 1]) {
      throw new Error('Missing value for --base-url');
    }
    baseUrl = filtered[baseUrlIndex + 1];
    filtered.splice(baseUrlIndex, 2);
  }

  return { filtered, pretty, baseUrl: baseUrl.replace(/\/$/, '') };
}

async function parseJsonBody(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return { raw: text };
  }
}

function formatHumanResponse(subcommand, payload) {
  if (subcommand === 'init') {
    return [
      'Scan initiated.',
      `scanId: ${payload.scanId ?? 'unknown'}`,
      `status: ${payload.status ?? 'unknown'}`
    ].join('\n');
  }

  if (subcommand === 'status') {
    return [
      `scanId: ${payload.scanId ?? 'unknown'}`,
      `state: ${payload.state ?? payload.status ?? 'unknown'}`
    ].join('\n');
  }

  if (subcommand === 'results') {
    return [
      `scanId: ${payload.scanId ?? 'unknown'}`,
      `status: ${payload.status ?? payload.state ?? 'unknown'}`,
      `audit_id: ${payload.audit_id ?? payload.result?.audit_id ?? 'n/a'}`
    ].join('\n');
  }

  return JSON.stringify(payload, null, 2);
}

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

export async function runCli(
  argv,
  io = { log: globalThis.console.log, error: globalThis.console.error }
) {
  try {
    const { filtered, pretty, baseUrl } = parseArgs(argv);

    if (filtered.length < 2 || filtered[0] !== 'scan') {
      printUsage(io);
      return 1;
    }

    const subcommand = filtered[1];
    let endpoint = null;
    let requestInit = { method: 'GET' };

    if (subcommand === 'init') {
      endpoint = `${baseUrl}/api/scan/initiate`;
      requestInit = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'private_ephemeral',
          target: createHostedSummaryTarget(),
          metadata: {
            agent: 'moltbench-cli'
          }
        })
      };
    } else if (subcommand === 'status') {
      const scanId = filtered[2];
      if (!scanId) {
        throw new Error('scan status requires <scanId>');
      }
      endpoint = `${baseUrl}/api/scan/status/${encodeURIComponent(scanId)}`;
    } else if (subcommand === 'results') {
      const scanId = filtered[2];
      if (!scanId) {
        throw new Error('scan results requires <scanId>');
      }
      endpoint = `${baseUrl}/api/scan/results/${encodeURIComponent(scanId)}`;
    } else {
      printUsage(io);
      return 1;
    }

    const response = await globalThis.fetch(endpoint, requestInit);
    const payload = await parseJsonBody(response);

    if (!response.ok) {
      io.error(`Request failed (${response.status} ${response.statusText})`);
      io.error(
        typeof payload === 'object' && payload && 'message' in payload
          ? payload.message
          : JSON.stringify(payload)
      );
      return 1;
    }

    if (pretty) {
      io.log(formatHumanResponse(subcommand, payload));
      io.log('\nRaw JSON:');
      io.log(JSON.stringify(payload, null, 2));
    } else {
      io.log(JSON.stringify(payload));
    }

    return 0;
  } catch (error) {
    io.error(error instanceof Error ? error.message : 'Unknown CLI error');
    return 1;
  }
}

if (import.meta.url === `file://${globalThis.process.argv[1]}`) {
  const code = await runCli(globalThis.process.argv.slice(2));
  globalThis.process.exit(code);
}