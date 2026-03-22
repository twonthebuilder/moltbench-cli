import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { URL } from 'node:url';

import { runCli } from '../moltbenchCli.mjs';
import pairingRedeemHandler from '../../../api/agents/pairing/redeem.js';
import rotateHandler from '../../../api/agents/keys/rotate.js';
import revokeHandler from '../../../api/agents/keys/revoke.js';
import attestationRequestHandler from '../../../api/scan/attestation/request.js';
import scanInitiateHandler from '../../../api/scan/initiate.js';
import scanStatusHandler from '../../../api/scan/status/[id].js';
import scanResultsHandler from '../../../api/scan/results/[id].js';
import capabilitiesHandler from '../../../api/capabilities.js';

const STATUS_TEXT = {
  200: 'OK',
  201: 'Created',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  425: 'Too Early',
  429: 'Too Many Requests',
  503: 'Service Unavailable'
};

function createMockResponse() {
  return {
    statusCode: 200,
    payload: null,
    endedBody: '',
    headers: {},
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.payload = body;
      return this;
    },
    end(body = '') {
      this.endedBody = body;
      return this;
    }
  };
}

async function localPairingRedeemHarness(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let parsed = {};
  try {
    parsed = typeof req.body === 'string' && req.body ? JSON.parse(req.body) : (req.body ?? {});
  } catch {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  if (typeof parsed.code !== 'string' || !/^[A-Z2-9]{6,8}$/.test(parsed.code.trim())) {
    return res.status(400).json({ error: 'Invalid pairing code' });
  }

  return res.status(400).json({ error: 'Invalid pairing code' });
}

async function invokeRoute(url, init = {}) {
  const parsedUrl = new URL(url);
  const pathname = parsedUrl.pathname;
  const method = init.method ?? 'GET';
  const headers = init.headers ?? {};

  const req = {
    method,
    headers,
    body: init.body,
    query: {}
  };

  let handler = null;
  if (pathname === '/api/agents/pairing/redeem') {
    handler = localPairingRedeemHarness;
  } else if (pathname === '/api/agents/keys/rotate') {
    handler = rotateHandler;
  } else if (pathname === '/api/agents/keys/revoke') {
    handler = revokeHandler;
  } else if (pathname === '/api/scan/attestation/request') {
    handler = attestationRequestHandler;
  } else if (pathname === '/api/scan/initiate') {
    handler = scanInitiateHandler;
  } else if (pathname === '/api/capabilities') {
    handler = capabilitiesHandler;
  } else if (pathname.startsWith('/api/scan/status/')) {
    handler = scanStatusHandler;
    req.query.id = decodeURIComponent(pathname.replace('/api/scan/status/', ''));
  } else if (pathname.startsWith('/api/scan/results/')) {
    handler = scanResultsHandler;
    req.query.id = decodeURIComponent(pathname.replace('/api/scan/results/', ''));
  }

  assert.ok(handler, `No handler for route ${pathname}`);

  const res = createMockResponse();
  await handler(req, res);

  const payload = res.payload ?? (res.endedBody ? JSON.parse(res.endedBody) : null);

  return {
    ok: res.statusCode >= 200 && res.statusCode < 300,
    status: res.statusCode,
    statusText: STATUS_TEXT[res.statusCode] ?? 'Unknown',
    payload,
    async text() {
      return payload == null ? '' : JSON.stringify(payload);
    }
  };
}

test('release contract: real pair handler preserves method-not-allowed error key', async () => {
  const req = { method: 'GET', headers: {}, body: null };
  const res = createMockResponse();
  await pairingRedeemHandler(req, res);

  assert.equal(res.statusCode, 405);
  assert.deepEqual(res.payload, { error: 'Method not allowed' });
});

test('release contract: CLI request construction aligns with API handlers and error keys', async () => {
  const requests = [];
  const originalFetch = globalThis.fetch;
  const originalAgentPath = process.env.MOLTBENCH_AGENT_KEY_PATH;

  const tempDir = await mkdtemp(path.join(tmpdir(), 'moltbench-contract-'));
  const credentialPath = path.join(tempDir, 'agent.json');
  await writeFile(
    credentialPath,
    JSON.stringify({ agentId: 'agent-local', keyId: 'key_local', apiKey: 'mbk_key_local.invalid' })
  );

  process.env.MOLTBENCH_AGENT_KEY_PATH = credentialPath;

  globalThis.fetch = async (url, init) => {
    const request = { url, init, response: null };
    requests.push(request);
    const response = await invokeRoute(url, init);
    request.response = response;
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      async text() {
        return JSON.stringify(response.payload);
      }
    };
  };

  try {
    const cases = [
      {
        name: 'agent pair',
        argv: ['agent', 'pair', '--code', 'BADCODE'],
        expectedStatus: 400,
        expectedPath: '/api/agents/pairing/redeem',
        expectedMethod: 'POST'
      },
      {
        name: 'agent rotate',
        argv: ['agent', 'rotate'],
        expectedStatus: 401,
        expectedPath: '/api/agents/keys/rotate',
        expectedMethod: 'POST'
      },
      {
        name: 'agent revoke',
        argv: ['agent', 'revoke'],
        expectedStatus: 401,
        expectedPath: '/api/agents/keys/revoke',
        expectedMethod: 'POST'
      },
      {
        name: 'agent attest',
        argv: ['agent', 'attest', '--run-id', 'run-1', '--moltbench-user-id', 'user-1', '--yes'],
        expectedStatus: 401,
        expectedPath: '/api/scan/attestation/request',
        expectedMethod: 'POST'
      },
      {
        name: 'scan init',
        argv: ['scan', 'init'],
        expectedStatus: 401,
        expectedPath: '/api/scan/initiate',
        expectedMethod: 'POST'
      },
      {
        name: 'scan status',
        argv: ['scan', 'status', 'scan-1'],
        expectedStatus: 401,
        expectedPath: '/api/scan/status/scan-1',
        expectedMethod: 'GET'
      },
      {
        name: 'scan results',
        argv: ['scan', 'results', 'scan-1'],
        expectedStatus: 401,
        expectedPath: '/api/scan/results/scan-1',
        expectedMethod: 'GET'
      },
      {
        name: 'scan capabilities',
        argv: ['scan', 'capabilities'],
        expectedStatus: 200,
        expectedPath: '/api/capabilities',
        expectedMethod: 'GET'
      }
    ];

    for (const spec of cases) {
      const requestCountBefore = requests.length;
      const logs = [];
      const errors = [];
      const code = await runCli(spec.argv, {
        log: (line) => logs.push(line),
        error: (line) => errors.push(line)
      });

      const request = requests.at(requestCountBefore);
      assert.ok(request, `No request recorded for ${spec.name}`);
      assert.ok(request.response, `No response recorded for ${spec.name}`);

      const actualPath = new URL(request.url).pathname;
      assert.equal(actualPath, spec.expectedPath, `${spec.name} path contract mismatch`);
      assert.equal(
        request.init.method,
        spec.expectedMethod,
        `${spec.name} method contract mismatch`
      );
      assert.equal(
        request.response.status,
        spec.expectedStatus,
        `${spec.name} status contract mismatch`
      );

      if (spec.expectedStatus >= 400) {
        assert.equal(code, 1, `${spec.name} should fail for non-2xx responses`);
        assert.ok(
          request.response.payload && 'error' in request.response.payload,
          `${spec.name} error responses must expose an error key`
        );
        assert.match(errors.join('\n'), new RegExp(String(request.response.payload.error)));
      } else {
        assert.equal(code, 0, `${spec.name} should succeed for 2xx responses`);
        assert.match(logs.join('\n'), /deployment_mode:/);
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalAgentPath === undefined) {
      delete process.env.MOLTBENCH_AGENT_KEY_PATH;
    } else {
      process.env.MOLTBENCH_AGENT_KEY_PATH = originalAgentPath;
    }
  }
});
