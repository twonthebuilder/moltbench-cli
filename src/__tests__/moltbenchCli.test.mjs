import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runCli } from '../../cli.mjs';

async function createQuickWorkspace() {
  const workspace = await mkdtemp(path.join(tmpdir(), 'moltbench-workspace-'));
  await writeFile(path.join(workspace, 'README.md'), '# sample workspace\n');
  return workspace;
}

test('scan init posts to initiate endpoint and prints json with --json', async () => {
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    return {
      ok: true,
      status: 202,
      statusText: 'Accepted',
      async text() {
        return JSON.stringify({ scanId: 'scan-1', status: 'queued' });
      }
    };
  };

  const logs = [];
  const errors = [];
  const code = await runCli(['scan', 'init', '--base-url', 'http://localhost:8787', '--json'], {
    log: (line) => logs.push(line),
    error: (line) => errors.push(line)
  });

  assert.equal(code, 0);
  assert.equal(errors.length, 0);
  assert.equal(requests[0].url, 'http://localhost:8787/api/scan/initiate');
  assert.equal(requests[0].init.method, 'POST');
  assert.match(logs[0], /scan-1/);
});

test('scan capabilities fetches capabilities endpoint and prints summary in human mode', async () => {
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      async text() {
        return JSON.stringify({
          deployment_mode: 'hosted',
          tier1_routes: {
            default: 'hosted_summary',
            allowed: ['hosted_summary']
          },
          auth_requirements: {
            gated_modes: {
              requires_authenticated_moltbench_user_id: ['private_account', 'onchain_agent']
            }
          }
        });
      }
    };
  };

  const logs = [];
  const errors = [];
  const code = await runCli(['scan', 'capabilities'], {
    log: (line) => logs.push(line),
    error: (line) => errors.push(line)
  });

  assert.equal(code, 0);
  assert.equal(errors.length, 0);
  assert.equal(requests[0].url, 'https://moltbench.vercel.app/api/capabilities');
  assert.equal(requests[0].init.method, 'GET');
  assert.match(logs[0], /deployment_mode: hosted/);
  assert.match(logs[0], /tier1_allowed_routes: hosted_summary/);
  assert.match(logs[0], /gated_modes_require_human_context: private_account, onchain_agent/);
  assert.match(logs[0], /\/api\/mcp\/tools\/scan\.results/);
});

test('scan status requires scan id', async () => {
  const logs = [];
  const errors = [];
  const code = await runCli(['scan', 'status'], {
    log: (line) => logs.push(line),
    error: (line) => errors.push(line)
  });

  assert.equal(code, 1);
  assert.equal(logs.length, 0);
  assert.equal(errors[0], 'scan status requires <scanId>');
});

test('error response prints message and exits 1', async () => {
  globalThis.fetch = async () => ({
    ok: false,
    status: 404,
    statusText: 'Not Found',
    async text() {
      return JSON.stringify({ message: 'Scan scan-missing was not found.' });
    }
  });

  const logs = [];
  const errors = [];
  const code = await runCli(['scan', 'results', 'scan-missing', '--json'], {
    log: (line) => logs.push(line),
    error: (line) => errors.push(line)
  });

  assert.equal(code, 1);
  assert.equal(logs.length, 0);
  assert.match(errors[0], /404/);
  assert.match(errors[0], /Scan scan-missing was not found\./);
});

test('scan quick parses local options and does not call fetch', async () => {
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error('unexpected fetch call');
  };

  const logs = [];
  const errors = [];
  const workspace = await createQuickWorkspace();
  const code = await runCli(
    [
      'scan',
      'quick',
      '--workspace',
      workspace,
      '--include-untracked',
      '--scope',
      'workspace',
      '--json'
    ],
    {
      log: (line) => logs.push(line),
      error: (line) => errors.push(line)
    }
  );

  assert.equal(code, 0);
  assert.equal(fetchCalled, false);
  assert.equal(errors.length, 0);

  const payload = JSON.parse(logs[0]);
  assert.equal(payload.workspace, workspace);
  assert.equal(payload.include_untracked, true);
  assert.equal(payload.tracked_files_only, false);
  assert.equal(payload.scope, 'workspace');
  assert.equal(payload.submit, false);
  assert.equal(payload.scan_options.include_untracked, true);
  assert.equal(payload.scan_options.include_workspace_scope, true);
});

test('scan quick defaults keep optional scan-scope flags disabled', async () => {
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('unexpected upload call');
  };

  const logs = [];
  const errors = [];
  const workspace = await createQuickWorkspace();
  const code = await runCli(['scan', 'quick', '--workspace', workspace, '--json'], {
    log: (line) => logs.push(line),
    error: (line) => errors.push(line)
  });

  assert.equal(code, 0);
  assert.equal(errors.length, 0);
  assert.equal(fetchCalls, 0);

  const payload = JSON.parse(logs[0]);
  assert.equal(payload.include_untracked, false);
  assert.equal(payload.tracked_files_only, true);
  assert.equal(payload.scope, 'tracked');
  assert.equal(payload.submit, false);
  assert.equal(payload.scan_options.include_untracked, false);
  assert.equal(payload.scan_options.include_workspace_scope, false);
});

test('scan quick submit is opt-in and sends only redacted aggregate summary fields', async () => {
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    return {
      ok: true,
      status: 202,
      statusText: 'Accepted',
      async text() {
        return JSON.stringify({ scanId: 'scan-submit-1', state: 'queued' });
      }
    };
  };

  const logs = [];
  const errors = [];
  const code = await runCli(
    ['scan', 'quick', '--workspace', await createQuickWorkspace(), '--submit', '--json'],
    {
      log: (line) => logs.push(line),
      error: (line) => errors.push(line)
    }
  );

  assert.equal(code, 0);
  assert.equal(errors.length, 0);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://moltbench.vercel.app/api/scan/initiate');

  const requestPayload = JSON.parse(requests[0].init.body);
  assert.equal(requestPayload.target.type, 'hosted_summary');
  assert.deepEqual(Object.keys(requestPayload.target.summary).sort(), [
    'findings',
    'generated_at',
    'metadata',
    'provenance',
    'raw',
    'runner_version',
    'schema_version',
    'target'
  ]);
  assert.deepEqual(requestPayload.target.summary.raw, []);
  assert.equal(requestPayload.target.summary.target, 'runner://moltbench-cli/local-quick');
  assert.deepEqual(requestPayload.target.summary.findings, []);
  assert.equal(requestPayload.target.summary.metadata.counts.findings_total, 0);
  assert.equal(requestPayload.target.summary.metadata.options.scope, 'tracked');
  assert.equal(requestPayload.target.summary.metadata.options.include_untracked, false);
  assert.equal(requestPayload.target.summary.metadata.options.tracked_files_only, true);
  assert.match(requestPayload.target.summary.provenance.run_id, /^moltbench-cli-local-quick-/);
  assert.match(requestPayload.target.summary.provenance.nonce, /^moltbench-cli-local-quick-/);

  const responsePayload = JSON.parse(logs[0]);
  assert.equal(responsePayload.submit, true);
  assert.equal(responsePayload.submission.scanId, 'scan-submit-1');
});

test('scan quick with no local args prints usage and exits 1', async () => {
  const logs = [];
  const errors = [];
  const code = await runCli(['scan', 'quick'], {
    log: (line) => logs.push(line),
    error: (line) => errors.push(line)
  });

  assert.equal(code, 1);
  assert.equal(errors[0], 'scan quick requires --workspace <path>');
  assert.match(logs[0], /moltbench scan quick --workspace <path>/);
});

test('scan results prints local metadata, gate, score, and finding evidence in human mode', async () => {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    async text() {
      return JSON.stringify({
        scanId: 'scan-local-1',
        scan_artifact: {
          scan_id: 'scan-local-1',
          gate_result: 'FAIL',
          score: 35,
          static_scan: {
            source: 'local_path',
            scanned_files: 2
          },
          findings: [
            {
              title: 'Potential OpenAI API key in plaintext',
              local_evidence: {
                file_path: 'secrets.env',
                line: 1,
                excerpt: 'OPENAI_KEY=sk-12345678901234567890123'
              }
            }
          ]
        }
      });
    }
  });

  const logs = [];
  const errors = [];
  const code = await runCli(['scan', 'results', 'scan-local-1'], {
    log: (line) => logs.push(line),
    error: (line) => errors.push(line)
  });

  assert.equal(code, 0);
  assert.equal(errors.length, 0);
  assert.match(logs[0], /metadata:/);
  assert.match(logs[0], /gate: FAIL/);
  assert.match(logs[0], /score: 35/);
  assert.match(logs[0], /path: secrets.env/);
  assert.match(logs[0], /line: 1/);
  assert.match(logs[0], /excerpt: OPENAI_KEY=sk-12345678901234567890123/);
});

test('agent pair redeems pairing code, stores delegate key, and prints warning', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'moltbench-cli-test-'));
  globalThis.process.env.MOLTBENCH_AGENT_KEY_PATH = path.join(tempDir, 'agent.json');

  try {
    const requests = [];
    globalThis.fetch = async (url, init) => {
      requests.push({ url, init });
      return {
        ok: true,
        status: 201,
        statusText: 'Created',
        async text() {
          return JSON.stringify({
            agentId: 'agent_123',
            keyId: 'key_123',
            apiKey: 'mbk_key_123.secret',
            createdAt: '2026-01-01T00:00:00.000Z',
            expiresAt: null,
            keyDelivery: 'one_time_plaintext'
          });
        }
      };
    };

    const logs = [];
    const errors = [];
    const code = await runCli(['agent', 'pair', '--code', 'ABCD2345'], {
      log: (line) => logs.push(line),
      error: (line) => errors.push(line)
    });

    assert.equal(code, 0);
    assert.equal(errors.length, 0);
    assert.equal(requests[0].url, 'https://moltbench.vercel.app/api/agents/pairing/redeem');
    assert.equal(requests[0].init.method, 'POST');
    assert.equal(JSON.parse(requests[0].init.body).code, 'ABCD2345');
    assert.match(logs.join('\n'), /apiKey \(one-time\): mbk_key_123\.secret/);
    assert.match(logs.join('\n'), /delegated agent credential/i);

    const stored = JSON.parse(
      await readFile(globalThis.process.env.MOLTBENCH_AGENT_KEY_PATH, 'utf8')
    );
    assert.equal(stored.agentId, 'agent_123');
    assert.equal(stored.keyId, 'key_123');
    assert.equal(stored.apiKey, 'mbk_key_123.secret');
  } finally {
    delete globalThis.process.env.MOLTBENCH_AGENT_KEY_PATH;
  }
});

test('agent rotate uses stored key for protected call and updates stored credential', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'moltbench-cli-test-'));
  globalThis.process.env.MOLTBENCH_AGENT_KEY_PATH = path.join(tempDir, 'agent.json');

  try {
    await writeFile(
      globalThis.process.env.MOLTBENCH_AGENT_KEY_PATH,
      JSON.stringify({ agentId: 'agent_1', keyId: 'key_old', apiKey: 'mbk_key_old.secret' })
    );

    const requests = [];
    globalThis.fetch = async (url, init) => {
      requests.push({ url, init });
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        async text() {
          return JSON.stringify({
            agentId: 'agent_1',
            revokedKeyId: 'key_old',
            keyId: 'key_new',
            apiKey: 'mbk_key_new.secret',
            createdAt: '2026-01-02T00:00:00.000Z',
            expiresAt: null,
            keyDelivery: 'one_time_plaintext'
          });
        }
      };
    };

    const logs = [];
    const errors = [];
    const code = await runCli(['agent', 'rotate', '--json'], {
      log: (line) => logs.push(line),
      error: (line) => errors.push(line)
    });

    assert.equal(code, 0);
    assert.equal(errors.length, 0);
    assert.equal(requests[0].url, 'https://moltbench.vercel.app/api/agents/keys/rotate');
    assert.equal(requests[0].init.method, 'POST');
    assert.equal(requests[0].init.headers.Authorization, 'Bearer mbk_key_old.secret');
    assert.equal(requests[0].init.body, '{}');

    const stored = JSON.parse(
      await readFile(globalThis.process.env.MOLTBENCH_AGENT_KEY_PATH, 'utf8')
    );
    assert.equal(stored.keyId, 'key_new');
    assert.equal(stored.apiKey, 'mbk_key_new.secret');
  } finally {
    delete globalThis.process.env.MOLTBENCH_AGENT_KEY_PATH;
  }
});

test('agent rotate surfaces handler error payload shape for delegated auth failures', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'moltbench-cli-test-'));
  globalThis.process.env.MOLTBENCH_AGENT_KEY_PATH = path.join(tempDir, 'agent.json');

  try {
    await writeFile(
      globalThis.process.env.MOLTBENCH_AGENT_KEY_PATH,
      JSON.stringify({ agentId: 'agent_1', keyId: 'key_old', apiKey: 'mbk_key_old.secret' })
    );

    globalThis.fetch = async () => ({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      async text() {
        return JSON.stringify({ error: 'API key revoked' });
      }
    });

    const logs = [];
    const errors = [];
    const code = await runCli(['agent', 'rotate', '--json'], {
      log: (line) => logs.push(line),
      error: (line) => errors.push(line)
    });

    assert.equal(code, 1);
    assert.equal(logs.length, 0);
    assert.match(errors[0], /Rotate failed \(403 Forbidden\)/);
    assert.equal(errors[1], 'API key revoked');
  } finally {
    delete globalThis.process.env.MOLTBENCH_AGENT_KEY_PATH;
  }
});

test('agent revoke uses stored key for protected call', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'moltbench-cli-test-'));
  globalThis.process.env.MOLTBENCH_AGENT_KEY_PATH = path.join(tempDir, 'agent.json');

  try {
    await writeFile(
      globalThis.process.env.MOLTBENCH_AGENT_KEY_PATH,
      JSON.stringify({ agentId: 'agent_1', keyId: 'key_old', apiKey: 'mbk_key_old.secret' })
    );

    const requests = [];
    globalThis.fetch = async (url, init) => {
      requests.push({ url, init });
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        async text() {
          return JSON.stringify({
            agentId: 'agent_1',
            keyId: 'key_old',
            revokedAt: '2026-01-03T00:00:00.000Z'
          });
        }
      };
    };

    const logs = [];
    const errors = [];
    const code = await runCli(['agent', 'revoke', '--json'], {
      log: (line) => logs.push(line),
      error: (line) => errors.push(line)
    });

    assert.equal(code, 0);
    assert.equal(errors.length, 0);
    assert.equal(requests[0].url, 'https://moltbench.vercel.app/api/agents/keys/revoke');
    assert.equal(requests[0].init.method, 'POST');
    assert.equal(requests[0].init.headers.Authorization, 'Bearer mbk_key_old.secret');
    assert.equal(requests[0].init.body, '{}');
  } finally {
    delete globalThis.process.env.MOLTBENCH_AGENT_KEY_PATH;
  }
});

test('agent pair invalid code fails with actionable error', async () => {
  globalThis.fetch = async () => ({
    ok: false,
    status: 400,
    statusText: 'Bad Request',
    async text() {
      return JSON.stringify({ error: 'Invalid or expired pairing code' });
    }
  });

  const logs = [];
  const errors = [];
  const code = await runCli(['agent', 'pair', '--code', 'BADCODE'], {
    log: (line) => logs.push(line),
    error: (line) => errors.push(line)
  });

  assert.equal(code, 1);
  assert.equal(logs.length, 0);
  assert.match(errors[0], /Pairing failed/);
  assert.equal(errors[1], 'Invalid or expired pairing code');
  assert.match(errors[2], /request a fresh pairing code/i);
});

test('agent attest prompts on first attempt and can cancel safely', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'moltbench-cli-test-'));
  globalThis.process.env.HOME = tempDir;
  globalThis.process.env.MOLTBENCH_AGENT_KEY_PATH = path.join(tempDir, 'agent.json');

  try {
    await writeFile(
      globalThis.process.env.MOLTBENCH_AGENT_KEY_PATH,
      JSON.stringify({ agentId: 'agent_123', keyId: 'key_123', apiKey: 'mbk_key_123.secret' })
    );

    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      throw new Error('unexpected fetch call');
    };

    const logs = [];
    const errors = [];
    const code = await runCli(
      ['agent', 'attest', '--run-id', 'run_1', '--moltbench-user-id', 'mb-user-1'],
      {
        log: (line) => logs.push(line),
        error: (line) => errors.push(line),
        confirm: async () => false
      }
    );

    assert.equal(code, 0);
    assert.equal(errors.length, 0);
    assert.equal(fetchCalled, false);
    assert.match(logs[0], /Attestation canceled/i);
  } finally {
    delete globalThis.process.env.MOLTBENCH_AGENT_KEY_PATH;
  }
});

test('agent attest submits attestation request with linked user+agent context', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'moltbench-cli-test-'));
  globalThis.process.env.HOME = tempDir;
  globalThis.process.env.MOLTBENCH_AGENT_KEY_PATH = path.join(tempDir, 'agent.json');

  try {
    await writeFile(
      globalThis.process.env.MOLTBENCH_AGENT_KEY_PATH,
      JSON.stringify({ agentId: 'agent_123', keyId: 'key_123', apiKey: 'mbk_key_123.secret' })
    );

    const requests = [];
    globalThis.fetch = async (url, init) => {
      requests.push({ url, init });
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        async text() {
          return JSON.stringify({
            run_id: 'run_1',
            audit_id: 'audit_1',
            attestation: { tx_hash: '0xabc123' }
          });
        }
      };
    };

    const logs = [];
    const errors = [];
    const code = await runCli(
      ['agent', 'attest', '--run-id', 'run_1', '--moltbench-user-id', 'mb-user-1', '--yes'],
      {
        log: (line) => logs.push(line),
        error: (line) => errors.push(line)
      }
    );

    assert.equal(code, 0);
    assert.equal(errors.length, 0);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://moltbench.vercel.app/api/scan/attestation/request');
    assert.equal(requests[0].init.headers.Authorization, 'Bearer mbk_key_123.secret');
    assert.equal(requests[0].init.headers['x-moltbench-user-id'], 'mb-user-1');
    assert.equal(requests[0].init.headers['x-moltbench-agent-id'], 'agent_123');
    assert.deepEqual(JSON.parse(requests[0].init.body), {
      run_id: 'run_1'
    });
    assert.match(logs[0], /On-chain attestation requested successfully/i);
  } finally {
    delete globalThis.process.env.MOLTBENCH_AGENT_KEY_PATH;
  }
});

test('scan results poller times out with actionable error when server never exits 425', async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const delays = [];

  globalThis.setTimeout = (callback, ms = 0) => {
    delays.push(ms);
    callback();
    return 0;
  };

  globalThis.fetch = async () => ({
    ok: false,
    status: 425,
    statusText: 'Too Early',
    async text() {
      return JSON.stringify({
        error: 'Scan is still in progress',
        retryAfterMs: 200,
        maxWaitMs: 700,
        lastProgressAt: '2026-01-01T00:00:00.000Z'
      });
    }
  });

  try {
    const logs = [];
    const errors = [];
    const code = await runCli(['scan', 'results', 'scan-timeout'], {
      log: (line) => logs.push(line),
      error: (line) => errors.push(line)
    });

    assert.equal(code, 1);
    assert.equal(logs.length, 0);
    assert.match(errors[0], /scan results timed out after 700ms/);
    assert.match(errors[0], /Last progress update: 2026-01-01T00:00:00.000Z/);
    assert.deepEqual(delays, [500]);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test('scan init forwards normalized focus options to hosted metadata', async () => {
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      async text() {
        return JSON.stringify({ scanId: 'scan-focus', state: 'done' });
      }
    };
  };

  const code = await runCli(
    ['scan', 'init', '--focus', 'secrets_detection,invalid,lockfile_hygiene', '--json'],
    {
      log: () => {},
      error: () => {}
    }
  );

  assert.equal(code, 0);
  const body = JSON.parse(requests[0].init.body);
  assert.deepEqual(body.metadata.scan_focus, ['secrets_detection', 'lockfile_hygiene']);
  assert.equal(body.target.summary.metadata.mode, 'hosted');
  assert.deepEqual(body.target.summary.metadata.requested_adapters, []);
});

test('scan init local mode runs selected adapters and submits real findings', async () => {
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      async text() {
        return JSON.stringify({ scanId: 'scan-local', state: 'done' });
      }
    };
  };

  const workspace = await createQuickWorkspace();
  await writeFile(path.join(workspace, '.env'), 'API_KEY=secret-123\n');

  const code = await runCli(
    ['scan', 'init', '--mode', 'local', '--target', workspace, '--adapters', 'secrets', '--json'],
    {
      log: () => {},
      error: () => {}
    }
  );

  assert.equal(code, 0);
  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.target.type, 'hosted_summary');
  assert.equal(body.target.summary.metadata.mode, 'local');
  assert.equal(body.target.summary.metadata.adapters_executed[0], 'secrets');
  assert.ok(body.target.summary.findings.length >= 1);
  assert.equal(body.target.summary.raw.length, 0);
});

test('scan init local mode requires target', async () => {
  const logs = [];
  const errors = [];

  const code = await runCli(['scan', 'init', '--mode', 'local'], {
    log: (line) => logs.push(line),
    error: (line) => errors.push(line)
  });

  assert.equal(code, 1);
  assert.equal(logs.length, 0);
  assert.match(errors[0], /requires --target <path-or-url>/i);
});

test('scan list fetches history endpoint', async () => {
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      async text() {
        return JSON.stringify({ scans: [] });
      }
    };
  };

  const code = await runCli(['scan', 'list', '--limit', '5', '--json'], {
    log: () => {},
    error: () => {}
  });

  assert.equal(code, 0);
  assert.equal(requests[0].url, 'https://moltbench.vercel.app/api/scan/list?limit=5');
  assert.equal(requests[0].init.method, 'GET');
});

test('agent attest can omit user id header and rely on server-side resolution', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'moltbench-cli-test-'));
  globalThis.process.env.HOME = tempDir;
  globalThis.process.env.MOLTBENCH_AGENT_KEY_PATH = path.join(tempDir, 'agent.json');

  try {
    await writeFile(
      globalThis.process.env.MOLTBENCH_AGENT_KEY_PATH,
      JSON.stringify({ agentId: 'agent_123', keyId: 'key_123', apiKey: 'mbk_key_123.secret' })
    );

    const requests = [];
    globalThis.fetch = async (url, init) => {
      requests.push({ url, init });
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        async text() {
          return JSON.stringify({ run_id: 'run_1', audit_id: 'audit_1', attestation: {} });
        }
      };
    };

    const code = await runCli(['agent', 'attest', '--run-id', 'run_1', '--yes', '--json'], {
      log: () => {},
      error: () => {}
    });

    assert.equal(code, 0);
    assert.equal(requests[0].init.headers['x-moltbench-user-id'], undefined);
    assert.equal(requests[0].init.headers['x-moltbench-agent-id'], 'agent_123');
  } finally {
    delete globalThis.process.env.MOLTBENCH_AGENT_KEY_PATH;
  }
});

test('subcommand help exits early without calling APIs', async () => {
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    throw new Error('unexpected');
  };

  const logs = [];
  const code = await runCli(['scan', 'init', '--help'], {
    log: (line) => logs.push(line),
    error: () => {}
  });

  assert.equal(code, 0);
  assert.equal(called, false);
  assert.match(logs[0], /Usage:/);
});
