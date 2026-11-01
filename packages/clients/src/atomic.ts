import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * 配置文件的原子写入与备份。
 *
 * 顺序不可调整（docs/security/security-policy.md §4）：
 *   读取 → 校验 → 冲突检测 → 备份 → 临时文件 → 校验 → 原子替换 → 重读校验 → 失败恢复
 *
 * 这里只负责「文件层面」的安全；「要不要写、写什么」由客户端适配器决定。
 */

export interface BackupInfo {
  name: string;
  path: string;
  createdAt: string;
  size: number;
  hash: string;
}

export interface WriteOptions {
  /** 写入前期望的文件内容哈希；不匹配就拒绝（外部修改冲突）。null 表示文件应不存在。 */
  expectedHash: string | null;
  backupDir: string;
  clientId: string;
}

export interface WriteResult {
  backup: BackupInfo | null;
  hash: string;
}

export class ConfigWriteError extends Error {
  readonly code: 'conflict' | 'io' | 'invalid';
  readonly detail?: string;

  constructor(code: 'conflict' | 'io' | 'invalid', message: string, detail?: string) {
    super(message);
    this.name = 'ConfigWriteError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export async function readConfigFile(
  path: string,
): Promise<{ exists: boolean; content: string; hash: string | null }> {
  try {
    const content = await readFile(path, 'utf8');
    return { exists: true, content, hash: hashContent(content) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { exists: false, content: '', hash: null };
    }
    throw new ConfigWriteError('io', `无法读取配置文件：${path}`, String(error));
  }
}

const BACKUP_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{8}\.json$/;

/** 备份文件名必须完全匹配我们自己生成的格式，防止从渲染层传入路径穿越。 */
export function isSafeBackupName(name: string): boolean {
  return BACKUP_NAME.test(name);
}

export async function listBackups(backupDir: string): Promise<BackupInfo[]> {
  let names: string[];
  try {
    names = await readdir(backupDir);
  } catch {
    return [];
  }

  const backups: BackupInfo[] = [];
  for (const name of names) {
    if (!isSafeBackupName(name)) continue;
    const path = join(backupDir, name);
    try {
      const [content, info] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
      backups.push({
        name,
        path,
        createdAt: info.mtime.toISOString(),
        size: info.size,
        hash: hashContent(content),
      });
    } catch {
      // 备份读不了就跳过，不影响主流程。
    }
  }
  return backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function writeBackup(path: string, backupDir: string, content: string): Promise<BackupInfo> {
  await mkdir(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = `${stamp}-${hashContent(content).slice(0, 8)}.json`;
  const target = join(backupDir, name);
  await writeFile(target, content, { encoding: 'utf8', mode: 0o600 });
  const info = await stat(target);
  return {
    name,
    path: target,
    createdAt: info.mtime.toISOString(),
    size: info.size,
    hash: hashContent(content),
  };
}

/**
 * 原子替换。
 *
 * 关键点：临时文件必须和目标文件在同一个目录（同一文件系统），
 * 否则 rename 会退化成复制，失去原子性。
 */
export async function writeConfigAtomically(
  path: string,
  content: string,
  options: WriteOptions,
): Promise<WriteResult> {
  const current = await readConfigFile(path);

  if (current.hash !== options.expectedHash) {
    throw new ConfigWriteError(
      'conflict',
      '配置文件在预览之后被改动过，请重新预览',
      `expected ${options.expectedHash ?? 'missing'}, found ${current.hash ?? 'missing'}`,
    );
  }

  const backup = current.exists
    ? await writeBackup(path, join(options.backupDir, options.clientId), current.content)
    : null;

  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.openferry-${process.pid}.tmp`;
  try {
    await writeFile(temp, content, { encoding: 'utf8', mode: 0o600 });

    // 写入前先确认临时文件本身是合法 JSON，避免把半截内容换上去。
    try {
      JSON.parse(await readFile(temp, 'utf8'));
    } catch {
      throw new ConfigWriteError('invalid', '生成的配置不是合法 JSON，已放弃写入');
    }

    await rename(temp, path);
  } catch (error) {
    await rename(temp, `${temp}.failed`).catch(() => {});
    if (error instanceof ConfigWriteError) throw error;
    throw new ConfigWriteError('io', '写入配置文件失败', String(error));
  }

  const after = await readConfigFile(path);
  if (after.hash !== hashContent(content)) {
    // 重读不一致：用备份还原，绝不留下一个「看起来写成功了」的文件。
    if (backup) await copyFile(backup.path, path).catch(() => {});
    throw new ConfigWriteError('io', '写入后校验失败，已尝试从备份恢复');
  }

  return { backup, hash: after.hash ?? hashContent(content) };
}

export async function restoreBackup(
  backupPath: string,
  targetPath: string,
  options: { backupDir: string; clientId: string },
): Promise<WriteResult> {
  const backupName = backupPath.split('/').pop() ?? '';
  if (!isSafeBackupName(backupName)) {
    throw new ConfigWriteError('invalid', '备份文件名不合法');
  }

  const content = await readFile(backupPath, 'utf8');
  try {
    JSON.parse(content);
  } catch {
    throw new ConfigWriteError('invalid', '备份内容不是合法 JSON，拒绝恢复');
  }

  const current = await readConfigFile(targetPath);
  return writeConfigAtomically(targetPath, content, {
    expectedHash: current.hash,
    backupDir: options.backupDir,
    clientId: options.clientId,
  });
}
