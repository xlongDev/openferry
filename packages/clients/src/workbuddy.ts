import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  ConfigWriteError,
  hashContent,
  readConfigFile,
  writeConfigAtomically,
  type BackupInfo,
} from './atomic.js';

/**
 * WorkBuddy 客户端适配器。
 *
 * 关于条目字段：`id`、`url`、`apiKey`、`local` 四个字段来自 WorkBuddy 自身的
 * 报错文案与清理逻辑（"Set the \"url\" field for this model" / "Set the \"apiKey\" field" /
 * 按 `local === true` 清理孤儿本地模型）。**没有用真实的非空 models.json 验证过**
 * 应用是否接受我们写出的条目 —— 这一点在 UI 与文档里都标为未验证。
 *
 * 因此策略是保守的：
 *  - 只增删我们自己写过的条目（归属记录在 OpenFerry 的数据库里）
 *  - 用户手写的条目原样保留，包括我们不认识的字段
 *  - 同 id 但非我们写入的条目一律跳过并告警，绝不覆盖
 */

export interface ClientEntry {
  id: string;
  [key: string]: unknown;
}

export interface ClientState {
  clientId: string;
  displayName: string;
  path: string;
  exists: boolean;
  readable: boolean;
  entryCount: number;
  entries: ClientEntry[];
  hash: string | null;
  error?: string;
}

export interface DesiredEntry {
  id: string;
  name: string;
  url: string;
  apiKey: string;
}

export type PlanAction = 'add' | 'update' | 'remove' | 'unchanged' | 'conflict';

export interface PlanItem {
  id: string;
  action: PlanAction;
  before: ClientEntry | null;
  after: ClientEntry | null;
  note?: string;
}

export interface ClientPlan {
  clientId: string;
  path: string;
  baseHash: string | null;
  items: PlanItem[];
  nextContent: string;
  warnings: string[];
}

export interface ApplyResult {
  ok: boolean;
  writtenIds: string[];
  removedIds: string[];
  backup: BackupInfo | null;
  error?: string;
}

export function resolveWorkBuddyPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['OPENFERRY_WORKBUDDY_DIR']?.trim();
  const configured = env['WORKBUDDY_CONFIG_DIR']?.trim();
  const dir = override ?? configured ?? join(homedir(), '.workbuddy');
  return join(dir, 'models.json');
}

function isEntry(value: unknown): value is ClientEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>)['id'] === 'string' &&
    ((value as Record<string, unknown>)['id'] as string).length > 0
  );
}

export async function inspectWorkBuddy(
  path: string = resolveWorkBuddyPath(),
): Promise<ClientState> {
  const base: ClientState = {
    clientId: 'workbuddy',
    displayName: 'WorkBuddy',
    path,
    exists: false,
    readable: false,
    entryCount: 0,
    entries: [],
    hash: null,
  };

  let file;
  try {
    file = await readConfigFile(path);
  } catch (error) {
    return { ...base, error: error instanceof Error ? error.message : String(error) };
  }

  if (!file.exists) return base;
  if (file.content.trim().length === 0) {
    // 空文件当作空数组，但保留 hash 以便冲突检测。
    return { ...base, exists: true, readable: true, hash: file.hash };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(file.content);
  } catch {
    return {
      ...base,
      exists: true,
      hash: file.hash,
      error: 'models.json 不是合法 JSON，已停止操作',
    };
  }

  if (!Array.isArray(parsed)) {
    return {
      ...base,
      exists: true,
      hash: file.hash,
      error: 'models.json 顶层不是数组，已停止操作',
    };
  }

  const entries = parsed.filter(isEntry);
  return {
    ...base,
    exists: true,
    readable: true,
    entryCount: entries.length,
    entries,
    hash: file.hash,
    ...(entries.length === parsed.length
      ? {}
      : { error: '有部分条目缺少 id 字段，已忽略这些条目' }),
  };
}

export function planWorkBuddy(
  state: ClientState,
  desired: DesiredEntry[],
  ownedIds: ReadonlySet<string>,
): ClientPlan {
  const items: PlanItem[] = [];
  const warnings: string[] = [];
  const byId = new Map(state.entries.map((entry) => [entry.id, entry]));
  const desiredById = new Map(desired.map((entry) => [entry.id, entry]));

  for (const entry of state.entries) {
    const want = desiredById.get(entry.id);
    if (want) {
      if (!ownedIds.has(entry.id)) {
        items.push({
          id: entry.id,
          action: 'conflict',
          before: entry,
          after: null,
          note: '同名条目已存在，但不是 OpenFerry 写入的，已跳过',
        });
        warnings.push(`条目 ${entry.id} 已存在且不是 OpenFerry 写入的，不会覆盖`);
        continue;
      }
      items.push({
        id: entry.id,
        action: 'update',
        before: entry,
        after: { ...entry, name: want.name, url: want.url, apiKey: want.apiKey, local: false },
      });
      continue;
    }

    if (ownedIds.has(entry.id)) {
      items.push({ id: entry.id, action: 'remove', before: entry, after: null });
    } else {
      items.push({ id: entry.id, action: 'unchanged', before: entry, after: entry });
    }
  }

  for (const want of desired) {
    if (byId.has(want.id)) continue;
    items.push({
      id: want.id,
      action: 'add',
      before: null,
      after: { id: want.id, name: want.name, url: want.url, apiKey: want.apiKey, local: false },
    });
  }

  // conflict 的条目必须原样写回：跳过它指的是「不覆盖」，不是「删掉」。
  const nextEntries = items
    .filter((item) => item.action !== 'remove')
    .map((item) => (item.action === 'conflict' ? item.before : item.after))
    .filter((entry): entry is ClientEntry => entry !== null);

  return {
    clientId: state.clientId,
    path: state.path,
    baseHash: state.hash,
    items,
    nextContent: `${JSON.stringify(nextEntries, null, 2)}\n`,
    warnings,
  };
}

export async function applyPlan(
  plan: ClientPlan,
  options: { backupDir: string },
): Promise<ApplyResult> {
  const writtenIds = plan.items
    .filter((i) => i.action === 'add' || i.action === 'update')
    .map((i) => i.id);
  const removedIds = plan.items.filter((i) => i.action === 'remove').map((i) => i.id);

  try {
    const result = await writeConfigAtomically(plan.path, plan.nextContent, {
      expectedHash: plan.baseHash,
      backupDir: options.backupDir,
      clientId: plan.clientId,
    });
    return { ok: true, writtenIds, removedIds, backup: result.backup };
  } catch (error) {
    return {
      ok: false,
      writtenIds: [],
      removedIds: [],
      backup: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export { ConfigWriteError, hashContent };
export type { BackupInfo };
