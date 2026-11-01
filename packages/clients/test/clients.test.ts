import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyPlan,
  inspectWorkBuddy,
  isSafeBackupName,
  listBackups,
  planWorkBuddy,
  restoreBackup,
  writeConfigAtomically,
} from '@openferry/clients';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'openferry-clients-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace(initial?: unknown): { dir: string; file: string; backups: string } {
  const dir = tempDir();
  const file = join(dir, 'models.json');
  if (initial !== undefined) {
    writeFileSync(file, typeof initial === 'string' ? initial : JSON.stringify(initial, null, 2));
  }
  return { dir, file, backups: join(dir, 'backups') };
}

const desired = (id: string) => ({
  id,
  name: `Model ${id}`,
  url: 'http://127.0.0.1:41980/v1',
  apiKey: 'gateway-token',
});

describe('inspectWorkBuddy', () => {
  it('reports a missing file without throwing', async () => {
    const { file } = workspace();
    const state = await inspectWorkBuddy(file);
    expect(state.exists).toBe(false);
    expect(state.entries).toEqual([]);
    expect(state.error).toBeUndefined();
  });

  it('accepts an empty array', async () => {
    const { file } = workspace([]);
    const state = await inspectWorkBuddy(file);
    expect(state.exists).toBe(true);
    expect(state.readable).toBe(true);
    expect(state.entryCount).toBe(0);
  });

  it('refuses to operate on invalid JSON', async () => {
    const { file } = workspace('{not json');
    const state = await inspectWorkBuddy(file);
    expect(state.readable).toBe(false);
    expect(state.error).toMatch(/JSON/);
  });

  it('refuses to operate when the top level is not an array', async () => {
    const { file } = workspace({ models: [] });
    const state = await inspectWorkBuddy(file);
    expect(state.readable).toBe(false);
    expect(state.error).toMatch(/数组/);
  });

  it('drops entries without an id and says so', async () => {
    const { file } = workspace([{ id: 'a' }, { name: 'no id' }]);
    const state = await inspectWorkBuddy(file);
    expect(state.entries).toHaveLength(1);
    expect(state.error).toMatch(/缺少 id/);
  });
});

describe('planWorkBuddy', () => {
  it('plans additions for new ids', async () => {
    const { file } = workspace([]);
    const state = await inspectWorkBuddy(file);
    const plan = planWorkBuddy(state, [desired('a'), desired('b')], new Set());
    expect(plan.items.map((i) => i.action)).toEqual(['add', 'add']);
    expect(JSON.parse(plan.nextContent)).toHaveLength(2);
  });

  it('removes only entries OpenFerry wrote', async () => {
    const { file } = workspace([{ id: 'mine' }, { id: 'theirs', custom: 'keep me' }]);
    const state = await inspectWorkBuddy(file);
    const plan = planWorkBuddy(state, [], new Set(['mine']));

    expect(plan.items.find((i) => i.id === 'mine')?.action).toBe('remove');
    expect(plan.items.find((i) => i.id === 'theirs')?.action).toBe('unchanged');
    const next = JSON.parse(plan.nextContent) as Array<Record<string, unknown>>;
    expect(next).toEqual([{ id: 'theirs', custom: 'keep me' }]);
  });

  it('refuses to overwrite an entry it does not own', async () => {
    const { file } = workspace([{ id: 'a', name: '用户手写' }]);
    const state = await inspectWorkBuddy(file);
    const plan = planWorkBuddy(state, [desired('a')], new Set());

    expect(plan.items[0]?.action).toBe('conflict');
    expect(plan.warnings[0]).toMatch(/不会覆盖/);
    expect(JSON.parse(plan.nextContent)).toEqual([{ id: 'a', name: '用户手写' }]);
  });

  it('updates an owned entry and keeps unknown fields', async () => {
    const { file } = workspace([{ id: 'a', name: 'old', customFlag: true }]);
    const state = await inspectWorkBuddy(file);
    const plan = planWorkBuddy(state, [desired('a')], new Set(['a']));

    expect(plan.items[0]?.action).toBe('update');
    const next = JSON.parse(plan.nextContent) as Array<Record<string, unknown>>;
    expect(next[0]).toMatchObject({
      id: 'a',
      name: 'Model a',
      url: 'http://127.0.0.1:41980/v1',
      local: false,
      customFlag: true,
    });
  });
});

describe('applyPlan', () => {
  it('writes the file and keeps a backup of the previous content', async () => {
    const { file, backups } = workspace([{ id: 'theirs' }]);
    const state = await inspectWorkBuddy(file);
    const plan = planWorkBuddy(state, [desired('a')], new Set());

    const result = await applyPlan(plan, { backupDir: backups });
    expect(result.ok).toBe(true);
    expect(result.writtenIds).toEqual(['a']);
    expect(result.backup).not.toBeNull();

    const written = JSON.parse(readFileSync(file, 'utf8')) as Array<Record<string, unknown>>;
    expect(written.map((entry) => entry['id'])).toEqual(['theirs', 'a']);
    expect(JSON.parse(readFileSync(result.backup!.path, 'utf8'))).toEqual([{ id: 'theirs' }]);
  });

  it('rejects the write when the file changed after the preview', async () => {
    const { file, backups } = workspace([{ id: 'theirs' }]);
    const state = await inspectWorkBuddy(file);
    const plan = planWorkBuddy(state, [desired('a')], new Set());

    writeFileSync(file, JSON.stringify([{ id: 'theirs' }, { id: 'sneaky' }]));

    const result = await applyPlan(plan, { backupDir: backups });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/改动过/);

    // 文件必须保持外部修改后的样子，不能被我们覆盖
    const after = JSON.parse(readFileSync(file, 'utf8')) as Array<Record<string, unknown>>;
    expect(after.map((entry) => entry['id'])).toEqual(['theirs', 'sneaky']);
  });

  it('creates the file when it does not exist yet', async () => {
    const { file, backups } = workspace();
    const state = await inspectWorkBuddy(file);
    const plan = planWorkBuddy(state, [desired('a')], new Set());

    const result = await applyPlan(plan, { backupDir: backups });
    expect(result.ok).toBe(true);
    expect(result.backup).toBeNull();
    expect(JSON.parse(readFileSync(file, 'utf8'))).toHaveLength(1);
  });

  it('leaves no temporary file behind', async () => {
    const { dir, file, backups } = workspace([]);
    const state = await inspectWorkBuddy(file);
    await applyPlan(planWorkBuddy(state, [desired('a')], new Set()), { backupDir: backups });
    const leftovers = readdirSync(dir).filter(
      (name) => name.includes('.tmp') || name.includes('.failed'),
    );
    expect(leftovers).toEqual([]);
  });
});

describe('backups', () => {
  it('lists backups newest first and rejects unsafe names', async () => {
    const { file, backups } = workspace([{ id: 'x' }]);
    const state = await inspectWorkBuddy(file);
    await applyPlan(planWorkBuddy(state, [desired('a')], new Set()), { backupDir: backups });

    const listed = await listBackups(join(backups, 'workbuddy'));
    expect(listed).toHaveLength(1);
    expect(isSafeBackupName(listed[0]!.name)).toBe(true);
    expect(isSafeBackupName('../../etc/passwd')).toBe(false);
    expect(isSafeBackupName('2026-01-01.json')).toBe(false);
  });

  it('restores a backup and backs up the current state first', async () => {
    const { file, backups } = workspace([{ id: 'original' }]);
    const state = await inspectWorkBuddy(file);
    const applied = await applyPlan(planWorkBuddy(state, [desired('a')], new Set()), {
      backupDir: backups,
    });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toHaveLength(2);

    await restoreBackup(applied.backup!.path, file, { backupDir: backups, clientId: 'workbuddy' });

    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([{ id: 'original' }]);
    const listed = await listBackups(join(backups, 'workbuddy'));
    expect(listed.length).toBeGreaterThanOrEqual(2);
  });

  it('refuses to restore a backup whose content is not JSON', async () => {
    const { file, backups } = workspace([]);
    const dir = join(backups, 'workbuddy');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dir, { recursive: true });
    const name = '2026-11-02T00-00-00-000Z-deadbeef.json';
    writeFileSync(join(dir, name), 'not json');

    await expect(
      restoreBackup(join(dir, name), file, { backupDir: backups, clientId: 'workbuddy' }),
    ).rejects.toThrow(/合法 JSON/);
  });
});

describe('writeConfigAtomically', () => {
  it('rejects a hash mismatch instead of clobbering', async () => {
    const { file, backups } = workspace([{ id: 'a' }]);
    await expect(
      writeConfigAtomically(file, '[]', {
        expectedHash: 'deadbeef',
        backupDir: backups,
        clientId: 'x',
      }),
    ).rejects.toThrow(/改动过/);
  });

  it('writes at most one backup per change', async () => {
    const { file, backups } = workspace([{ id: 'a' }]);
    const first = await inspectWorkBuddy(file);
    await writeConfigAtomically(file, JSON.stringify([{ id: 'b' }]), {
      expectedHash: first.hash,
      backupDir: backups,
      clientId: 'x',
    });
    const listed = await listBackups(join(backups, 'x'));
    expect(listed).toHaveLength(1);
  });
});
