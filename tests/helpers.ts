import { createLogger, type LoggerHandle } from '@openferry/core';
import { createGateway, type Gateway } from '@openferry/gateway';
import { OpenAICompatibleProvider } from '@openferry/provider-openai-compatible';
import type { ProviderAdapter, ProviderTimeouts } from '@openferry/provider-contract';
import { startFakeUpstream, type FakeStep, type FakeUpstream } from '@openferry/testkit';

export const TOKEN = 'test-token-123';

export interface SetupOptions {
  script?: FakeStep[];
  timeouts?: Partial<ProviderTimeouts>;
  maxConcurrency?: number;
  maxBodyBytes?: number;
  provider?: ProviderAdapter;
}

export interface Harness {
  upstream: FakeUpstream | null;
  gateway: Gateway;
  url: string;
  port: number;
  logger: LoggerHandle;
  close(): Promise<void>;
}

export async function setupGateway(options: SetupOptions = {}): Promise<Harness> {
  let upstream: FakeUpstream | null = null;
  let provider: ProviderAdapter;

  if (options.provider) {
    provider = options.provider;
  } else {
    upstream = await startFakeUpstream({
      ...(options.script === undefined ? {} : { script: options.script }),
      requireToken: 'sk-test',
    });
    provider = new OpenAICompatibleProvider({
      id: 'fake',
      baseUrl: upstream.url,
      apiKey: 'sk-test',
      allowPrivateNetwork: true,
    });
  }

  const logger = createLogger({ level: 'error' });
  const gateway = createGateway({
    providers: [provider],
    token: TOKEN,
    port: 0,
    ...(options.timeouts === undefined ? {} : { timeouts: options.timeouts }),
    ...(options.maxConcurrency === undefined ? {} : { maxConcurrency: options.maxConcurrency }),
    ...(options.maxBodyBytes === undefined ? {} : { maxBodyBytes: options.maxBodyBytes }),
    logger,
  });

  const { url, port } = await gateway.start();

  return {
    upstream,
    gateway,
    url,
    port,
    logger,
    async close() {
      await gateway.stop();
      if (upstream) await upstream.close();
    },
  };
}

export function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...extra };
}

export async function postChat(
  baseUrl: string,
  body: unknown,
  headers: Record<string, string> = authHeaders(),
): Promise<Response> {
  return fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

export function basicChatBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: 'fake/fake-model',
    messages: [{ role: 'user', content: 'hello' }],
    ...overrides,
  };
}

export async function readAllText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

/** 把网关输出的 SSE 拆成 JSON 载荷（丢掉 [DONE]）。 */
export function parseSseData(text: string): any[] {
  return text
    .split(/\r?\n\r?\n/)
    .map((block) => block.trim())
    .filter((block) => block.startsWith('data:'))
    .map((block) => block.slice(5).trim())
    .filter((data) => data.length > 0 && data !== '[DONE]')
    .map((data) => JSON.parse(data));
}
