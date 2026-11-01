import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations, migrations, openDatabase, StorageError } from '@openferry/storage';

const LATEST = migrations[migrations.length - 1]?.version ?? 0;

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
    expect(db.schemaVersion()).toBe(LATEST);
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
    expect(again.from).toBe(LATEST);
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
    expect(second.schemaVersion()).toBe(LATEST);
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

describe('models and probes', () => {
  function seed(db: ReturnType<typeof openDatabase>) {
    db.models.replaceForProvider('p', [
      {
        providerId: 'p',
        upstreamId: 'a',
        displayName: 'a',
        source: 'test',
        observedAt: '2026-11-02T00:00:00.000Z',
      },
      {
        providerId: 'p',
        upstreamId: 'b',
        displayName: 'b',
        source: 'test',
        observedAt: '2026-11-02T00:00:00.000Z',
      },
    ]);
  }

  const probe = (modelId: string) => ({
    modelId,
    probe: 'chat' as const,
    status: 'pass' as const,
    startedAt: '2026-11-02T00:00:00.000Z',
    durationMs: 10,
    expiresAt: '2026-11-02T06:00:00.000Z',
    probeVersion: '1.0.0',
  });

  it('replaces a provider catalogue and reports deltas', () => {
    const db = openDatabase(':memory:');
    const first = db.models.replaceForProvider('p', [
      { providerId: 'p', upstreamId: 'a', displayName: 'a', source: 'test', observedAt: 'x' },
    ]);
    expect(first).toEqual({ added: 1, removed: 0 });

    const second = db.models.replaceForProvider('p', [
      { providerId: 'p', upstreamId: 'b', displayName: 'b', source: 'test', observedAt: 'x' },
    ]);
    expect(second).toEqual({ added: 1, removed: 1 });
    expect(db.models.list().map((m) => m.id)).toEqual(['p/b']);
    db.close();
  });

  it('keeps only the latest probe per kind', () => {
    const db = openDatabase(':memory:');
    seed(db);
    db.probes.record({ ...probe('p/a'), evidence: 'first' });
    db.probes.record({ ...probe('p/a'), evidence: 'second' });

    const latest = db.probes.latestForModel('p/a');
    expect(latest).toHaveLength(1);
    expect(latest[0]?.evidence).toBe('second');
    expect(db.probes.historyForModel('p/a')).toHaveLength(2);
    db.close();
  });

  it('deletes probe history when the provider goes away', () => {
    const db = openDatabase(':memory:');
    seed(db);
    db.probes.record(probe('p/a'));
    db.probes.record(probe('p/b'));
    expect(db.probes.latestForModel('p/a')).toHaveLength(1);

    const deleted = db.probes.deleteForProvider('p');
    expect(deleted).toBe(2);
    expect(db.probes.latestForModel('p/a')).toEqual([]);
    db.close();
  });

  it('does not confuse a provider prefix with a longer id', () => {
    const db = openDatabase(':memory:');
    db.models.replaceForProvider('p', [
      { providerId: 'p', upstreamId: 'a', displayName: 'a', source: 'test', observedAt: 'x' },
    ]);
    db.models.replaceForProvider('p2', [
      { providerId: 'p2', upstreamId: 'a', displayName: 'a', source: 'test', observedAt: 'x' },
    ]);
    db.probes.record(probe('p/a'));
    db.probes.record(probe('p2/a'));

    expect(db.probes.deleteForProvider('p')).toBe(1);
    expect(db.probes.latestForModel('p2/a')).toHaveLength(1);
    db.close();
  });
});
