import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations, openDatabase, StorageError } from '@openferry/storage';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'openferry-storage-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('migrations', () => {
  it('creates the schema on a fresh database', () => {
    const db = openDatabase(':memory:');
    expect(db.schemaVersion()).toBe(1);
    const tables = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as unknown as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain('providers');
    expect(names).toContain('schema_migrations');
    db.close();
  });

  it('is idempotent on a second run', () => {
    const db = openDatabase(':memory:');
    const again = applyMigrations(db.raw, [
      {
        version: 1,
        name: 'providers',
        statements: ['CREATE TABLE IF NOT EXISTS providers (id TEXT)'],
      },
    ]);
    expect(again.applied).toEqual([]);
    expect(again.from).toBe(1);
    db.close();
  });

  it('rolls back the whole migration when one statement fails', () => {
    const raw = new DatabaseSync(':memory:');
    expect(() =>
      applyMigrations(raw, [
        {
          version: 1,
          name: 'broken',
          statements: ['CREATE TABLE good (id TEXT)', 'THIS IS NOT SQL'],
        },
      ]),
    ).toThrow(/migration 1 \(broken\) failed/);

    const tables = raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'good'")
      .all() as unknown as Array<{ name: string }>;
    expect(tables).toHaveLength(0);

    const applied = raw.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as {
      n: number;
    };
    expect(applied.n).toBe(0);
    raw.close();
  });
});

describe('provider repository', () => {
  it('creates, lists, updates and removes', () => {
    const db = openDatabase(':memory:');
    const created = db.providers.create({
      id: 'openai',
      displayName: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
    });

    expect(created.enabled).toBe(true);
    expect(created.allowPrivateNetwork).toBe(false);
    expect(created.credentialRef).toBeNull();
    expect(db.providers.list()).toHaveLength(1);

    const updated = db.providers.update('openai', { displayName: 'OpenAI 主账号', enabled: false });
    expect(updated.displayName).toBe('OpenAI 主账号');
    expect(updated.enabled).toBe(false);
    expect(updated.updatedAt >= created.updatedAt).toBe(true);

    expect(db.providers.remove('openai')).toBe(true);
    expect(db.providers.list()).toHaveLength(0);
    expect(db.providers.remove('openai')).toBe(false);
    db.close();
  });

  it('rejects duplicate ids', () => {
    const db = openDatabase(':memory:');
    db.providers.create({ id: 'a', displayName: 'A', baseUrl: 'https://a.example/v1' });
    try {
      db.providers.create({ id: 'a', displayName: 'A2', baseUrl: 'https://a.example/v1' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(StorageError);
      expect((error as StorageError).code).toBe('conflict');
    }
    db.close();
  });

  it('rejects malformed ids and reports which field is wrong', () => {
    const db = openDatabase(':memory:');
    try {
      db.providers.create({ id: 'Bad ID!', displayName: 'x', baseUrl: 'https://x.dev/v1' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as StorageError).code).toBe('invalid');
      expect((error as StorageError).message).toMatch(/id/);
    }
    db.close();
  });

  it('throws not_found when updating a missing provider', () => {
    const db = openDatabase(':memory:');
    try {
      db.providers.update('nope', { displayName: 'x' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as StorageError).code).toBe('not_found');
    }
    db.close();
  });

  it('persists across reopen', () => {
    const path = join(tempDir(), 'openferry.db');
    const first = openDatabase(path);
    first.providers.create({
      id: 'local',
      displayName: 'Ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
      allowPrivateNetwork: true,
    });
    first.close();

    const second = openDatabase(path);
    const list = second.providers.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.allowPrivateNetwork).toBe(true);
    expect(second.schemaVersion()).toBe(1);
    second.close();
  });

  it('keeps credentialRef separate from the key itself', () => {
    const db = openDatabase(':memory:');
    const record = db.providers.create({
      id: 'k',
      displayName: 'K',
      baseUrl: 'https://k.example/v1',
      credentialRef: 'k',
    });
    expect(record.credentialRef).toBe('k');
    // 数据库里不该出现任何形如密钥的字符串
    const dump = JSON.stringify(db.raw.prepare('SELECT * FROM providers').all());
    expect(dump).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
    db.close();
  });
});
