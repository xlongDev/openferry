import { afterEach, describe, expect, it } from 'vitest';
import { request } from 'node:http';
import { authHeaders, basicChatBody, setupGateway, TOKEN, type Harness } from '../helpers.js';

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

interface RawResponse {
  status: number;
  body: string;
}

function rawRequest(
  port: number,
  options: { path?: string; method?: string; headers?: Record<string, string>; body?: string },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: options.path ?? '/healthz',
        method: options.method ?? 'GET',
        headers: options.headers ?? {},
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

describe('browser fence', () => {
  it('rejects requests carrying an Origin header', async () => {
    harness = await setupGateway();
    const res = await fetch(`${harness.url}/v1/chat/completions`, {
      method: 'POST',
      headers: authHeaders({ origin: 'https://evil.example' }),
      body: JSON.stringify(basicChatBody()),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe('forbidden');
  });

  it('rejects requests carrying Sec-Fetch-Site headers', async () => {
    harness = await setupGateway();
    const res = await fetch(`${harness.url}/v1/models`, {
      headers: authHeaders({ 'sec-fetch-site': 'cross-site' }),
    });
    expect(res.status).toBe(403);
  });

  it('allows plain Node fetch clients (which send sec-fetch-mode: cors)', async () => {
    harness = await setupGateway();
    const res = await fetch(`${harness.url}/v1/models`, { headers: authHeaders() });
    expect(res.status).toBe(200);
  });

  it('rejects a foreign Host header', async () => {
    harness = await setupGateway();
    const res = await rawRequest(harness.port, {
      path: '/healthz',
      headers: { host: 'attacker.example:80' },
    });
    expect(res.status).toBe(403);
    expect(res.body).toContain('Host');
  });

  it('accepts localhost as a Host value', async () => {
    harness = await setupGateway();
    const res = await rawRequest(harness.port, {
      path: '/healthz',
      headers: { host: `localhost:${harness.port}` },
    });
    expect(res.status).toBe(200);
  });
});

describe('authentication', () => {
  it('rejects a wrong token', async () => {
    harness = await setupGateway();
    const res = await fetch(`${harness.url}/v1/models`, {
      headers: { authorization: 'Bearer wrong-token' },
    });
    expect(res.status).toBe(401);
  });

  it('accepts the configured token', async () => {
    harness = await setupGateway();
    const res = await fetch(`${harness.url}/v1/models`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  it('rejects a non-bearer scheme', async () => {
    harness = await setupGateway();
    const res = await fetch(`${harness.url}/v1/models`, {
      headers: { authorization: `Basic ${TOKEN}` },
    });
    expect(res.status).toBe(401);
  });
});

describe('error hygiene', () => {
  it('does not echo the gateway token in error bodies', async () => {
    harness = await setupGateway();
    const res = await fetch(`${harness.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: '{}',
    });
    const text = await res.text();
    expect(text).not.toContain(TOKEN);
  });

  it('never logs request bodies or credentials', async () => {
    harness = await setupGateway();
    await fetch(`${harness.url}/v1/chat/completions`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(
        basicChatBody({ messages: [{ role: 'user', content: 'TOP-SECRET-PROMPT' }] }),
      ),
    });
    const logs = JSON.stringify(harness.logger.recent(50));
    expect(logs).not.toContain('TOP-SECRET-PROMPT');
    expect(logs).not.toContain(TOKEN);
  });
});
