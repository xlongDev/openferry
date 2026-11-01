import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSecretStore, MemorySecretStore } from '@openferry/secrets';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'openferry-secrets-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('MemorySecretStore', () => {
  it('stores, lists and deletes without exposing values', async () => {
    const store = new MemorySecretStore();
    await store.set('openai', 'sk-test-value');
    expect(await store.get('openai')).toBe('sk-test-value');
    expect(await store.list()).toEqual(['openai']);
    await store.delete('openai');
    expect(await store.get('openai')).toBeUndefined();
    expect(await store.list()).toEqual([]);
  });
});

describe('FileSecretStore', () => {
  it('persists values across instances', async () => {
    const path = join(tempDir(), 'secrets.json');
    const first = new FileSecretStore(path);
    await first.set('openai', 'sk-first');

    const second = new FileSecretStore(path);
    expect(await second.get('openai')).toBe('sk-first');
    expect(await second.list()).toEqual(['openai']);
  });

  it('writes the file with 0600 permissions', async () => {
    const path = join(tempDir(), 'secrets.json');
    const store = new FileSecretStore(path);
    await store.set('a', 'value');
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('deleting a missing ref is a no-op', async () => {
    const path = join(tempDir(), 'secrets.json');
    const store = new FileSecretStore(path);
    await expect(store.delete('nope')).resolves.toBeUndefined();
  });

  it('treats a corrupt file as empty instead of throwing', async () => {
    const dir = tempDir();
    const path = join(dir, 'secrets.json');
    writeFileSync(path, 'not json at all', 'utf8');
    const store = new FileSecretStore(path);
    expect(await store.get('x')).toBeUndefined();
    expect(await store.list()).toEqual([]);
  });

  it('does not leave the temporary file behind', async () => {
    const dir = tempDir();
    const path = join(dir, 'secrets.json');
    const store = new FileSecretStore(path);
    await store.set('a', 'v');
    const files = readFileSync(path, 'utf8');
    expect(files).toContain('a');
    expect(readdirSync(dir)).toEqual(['secrets.json']);
  });
});
