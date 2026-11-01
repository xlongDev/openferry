import { describe, expect, it } from 'vitest';
import { ProtocolError, assertSafeProviderUrl } from '@openferry/core';

const rejects = (url: string, policy?: { allowPrivateNetwork?: boolean }): void => {
  expect(() => assertSafeProviderUrl(url, policy)).toThrow(ProtocolError);
};

describe('assertSafeProviderUrl', () => {
  it('accepts public https endpoints', () => {
    expect(assertSafeProviderUrl('https://api.openai.com/v1').hostname).toBe('api.openai.com');
  });

  it('rejects non-http protocols', () => {
    rejects('file:///etc/passwd');
    rejects('ftp://example.com/x');
  });

  it('rejects embedded credentials', () => {
    rejects('https://user:pass@api.example.com/v1');
  });

  it('rejects cloud metadata endpoints even with allowPrivateNetwork', () => {
    rejects('http://169.254.169.254/latest/meta-data/', { allowPrivateNetwork: true });
    rejects('http://metadata.google.internal/computeMetadata/v1/', { allowPrivateNetwork: true });
    rejects('http://100.100.100.200/latest/meta-data/', { allowPrivateNetwork: true });
  });

  it('rejects link-local addresses', () => {
    rejects('http://169.254.10.10/v1', { allowPrivateNetwork: true });
  });

  it('rejects loopback and private ranges by default', () => {
    rejects('http://127.0.0.1:11434/v1');
    rejects('http://10.0.0.5/v1');
    rejects('http://192.168.1.20:8080/v1');
    rejects('http://localhost:1234/v1');
  });

  it('allows loopback when explicitly permitted', () => {
    expect(
      assertSafeProviderUrl('http://127.0.0.1:11434/v1', { allowPrivateNetwork: true }).port,
    ).toBe('11434');
  });

  it('rejects integer and hex encoded loopback', () => {
    rejects('http://2130706433/v1');
    rejects('http://0x7f000001/v1');
  });

  it('rejects the unspecified address', () => {
    rejects('http://0.0.0.0:8080/v1', { allowPrivateNetwork: true });
  });

  it('allows exact host allowlist entries', () => {
    expect(
      assertSafeProviderUrl('http://internal-llm.corp:8080/v1', {
        allowedHosts: ['internal-llm.corp'],
      }).hostname,
    ).toBe('internal-llm.corp');
  });
});
