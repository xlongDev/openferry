import { afterEach, describe, expect, it } from 'vitest';
import { request } from 'node:http';
import { defaultCapabilities } from '@openferry/canonical';
import type { ProviderAdapter } from '@openferry/provider-contract';
import { authHeaders, basicChatBody, setupGateway, type Harness } from '../helpers.js';

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

/**
 * 一个可以被观察的流式供应商：它会在 signal abort 时记录，然后结束。
 * 用它来证明「客户端断开 → 上游被取消」这条链路真的接通了，
 * 而不是只断言网关返回了 200。
 */
function observableProvider(state: { aborted: boolean; finished: boolean }): ProviderAdapter {
  return {
    id: 'observable',
    capabilities: defaultCapabilities,
    listModels: async () => [],
    send: async () => {
      throw new Error('not used');
    },
    async *stream(_request, context) {
      yield { type: 'start', id: 'c1', model: 'm' };
      yield { type: 'text_delta', index: 0, text: 'first' };

      await new Promise<void>((resolve) => {
        if (context.signal.aborted) {
          state.aborted = true;
          resolve();
          return;
        }
        const timer = setTimeout(resolve, 3000);
        timer.unref();
        context.signal.addEventListener(
          'abort',
          () => {
            state.aborted = true;
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });

      state.finished = !state.aborted;
      yield { type: 'done', finishReason: 'stop' };
    },
  };
}

describe('cancellation', () => {
  it('aborts the upstream stream when the client disconnects', async () => {
    const state = { aborted: false, finished: false };
    harness = await setupGateway({ provider: observableProvider(state) });

    const body = JSON.stringify(basicChatBody({ stream: true }));

    await new Promise<void>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: harness!.port,
          path: '/v1/chat/completions',
          method: 'POST',
          headers: { ...authHeaders(), 'content-length': Buffer.byteLength(body) },
        },
        (res) => {
          res.once('data', () => {
            req.destroy();
            resolve();
          });
        },
      );
      req.on('error', (error) => {
        // 主动 destroy 会产生 ECONNRESET，这是预期行为。
        if ((error as NodeJS.ErrnoException).code === 'ECONNRESET') resolve();
        else reject(error);
      });
      req.write(body);
      req.end();
    });

    // 给 abort 传播留一点时间。
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(state.aborted).toBe(true);
    expect(state.finished).toBe(false);
  });

  it('returns 504 when the upstream produces no first event in time', async () => {
    const silent: ProviderAdapter = {
      id: 'silent',
      capabilities: defaultCapabilities,
      listModels: async () => [],
      send: async () => {
        throw new Error('not used');
      },
      async *stream(_request, context) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 2000);
          timer.unref();
          context.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
          });
        });
        yield { type: 'done', finishReason: 'stop' };
      },
    };

    harness = await setupGateway({ provider: silent, timeouts: { firstEventMs: 80 } });

    const res = await fetch(`${harness.url}/v1/chat/completions`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(basicChatBody({ stream: true })),
    });

    expect(res.status).toBe(504);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe('timeout');
  });
});
