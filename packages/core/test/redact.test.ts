import { describe, expect, it } from 'vitest';
import { createLogger, redact, redactString } from '@openferry/core';

describe('redact', () => {
  it('masks secret keys at any depth', () => {
    const input = {
      headers: { authorization: 'Bearer sk-1234567890abcdef', accept: 'application/json' },
      nested: [{ apiKey: 'sk-live-abc', cookie: 'session=1' }],
    };
    const out = redact(input) as Record<string, any>;
    expect(out['headers'].authorization).toBe('***redacted***');
    expect(out['headers'].accept).toBe('application/json');
    expect(out['nested'][0].apiKey).toBe('***redacted***');
    expect(out['nested'][0].cookie).toBe('***redacted***');
  });

  it('masks bearer tokens embedded in strings', () => {
    expect(redactString('Authorization: Bearer sk-abcdef123456')).toBe(
      'Authorization: Bearer ***redacted***',
    );
  });

  it('masks secrets in url query strings', () => {
    expect(redactString('https://x.dev/v1?api_key=sk-secret&model=gpt')).toBe(
      'https://x.dev/v1?api_key=***redacted***&model=gpt',
    );
  });

  it('does not throw on circular structures', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a['self'] = a;
    const out = redact(a) as Record<string, unknown>;
    expect(out['name']).toBe('a');
    expect(out['self']).toBe('[circular]');
  });

  it('keeps non-secret data intact', () => {
    const out = redact({ model: 'gpt-4o-mini', durationMs: 42 }) as Record<string, unknown>;
    expect(out).toEqual({ model: 'gpt-4o-mini', durationMs: 42 });
  });

  it('logger never emits a raw api key', () => {
    const records: Record<string, unknown>[] = [];
    const logger = createLogger({ level: 'debug', sink: (r) => records.push(r) });
    logger.info('provider.request', {
      providerId: 'openai',
      apiKey: 'sk-should-not-appear',
      headers: { authorization: 'Bearer sk-should-not-appear' },
    });
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain('sk-should-not-appear');
    expect(records[0]?.['providerId']).toBe('openai');
  });
});
