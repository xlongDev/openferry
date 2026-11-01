import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

export type StorageErrorCode = 'invalid' | 'conflict' | 'not_found';

export class StorageError extends Error {
  readonly code: StorageErrorCode;

  constructor(code: StorageErrorCode, message: string) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
  }
}

/**
 * 供应商配置。
 *
 * 注意 `credentialRef`：这里存的是密钥在 SecretStore 里的**引用名**，
 * 不是密钥本身。数据库里永远不出现明文 key。
 */
export const providerInputSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9_-]*$/, 'id 只能用小写字母、数字、下划线和连字符，且以字母或数字开头'),
  displayName: z.string().min(1).max(120),
  baseUrl: z.string().min(1).max(2048),
  credentialRef: z.string().min(1).max(120).nullable().optional(),
  allowPrivateNetwork: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

export type ProviderInput = z.infer<typeof providerInputSchema>;

export interface ProviderRecord {
  id: string;
  displayName: string;
  kind: 'openai-compatible';
  baseUrl: string;
  credentialRef: string | null;
  allowPrivateNetwork: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: string;
  display_name: string;
  kind: string;
  base_url: string;
  credential_ref: string | null;
  allow_private_network: number;
  enabled: number;
  created_at: string;
  updated_at: string;
}

function toRecord(row: Row): ProviderRecord {
  return {
    id: row.id,
    displayName: row.display_name,
    kind: 'openai-compatible',
    baseUrl: row.base_url,
    credentialRef: row.credential_ref,
    allowPrivateNetwork: row.allow_private_network === 1,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ProviderRepository {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  list(): ProviderRecord[] {
    const rows = this.#db
      .prepare('SELECT * FROM providers ORDER BY created_at ASC, id ASC')
      .all() as unknown as Row[];
    return rows.map(toRecord);
  }

  get(id: string): ProviderRecord | null {
    const row = this.#db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as unknown as
      Row | undefined;
    return row ? toRecord(row) : null;
  }

  create(input: ProviderInput): ProviderRecord {
    const parsed = providerInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new StorageError('invalid', parsed.error.issues.map((i) => i.message).join('; '));
    }
    const value = parsed.data;
    if (this.get(value.id)) {
      throw new StorageError('conflict', `provider "${value.id}" already exists`);
    }
    const now = new Date().toISOString();
    this.#db
      .prepare(
        `INSERT INTO providers
           (id, display_name, kind, base_url, credential_ref, allow_private_network, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        value.id,
        value.displayName,
        'openai-compatible',
        value.baseUrl,
        value.credentialRef ?? null,
        value.allowPrivateNetwork === true ? 1 : 0,
        value.enabled === false ? 0 : 1,
        now,
        now,
      );
    return this.get(value.id) as ProviderRecord;
  }

  update(id: string, patch: Partial<ProviderInput>): ProviderRecord {
    const existing = this.get(id);
    if (!existing) throw new StorageError('not_found', `provider "${id}" does not exist`);

    const merged = providerInputSchema.safeParse({
      id,
      displayName: patch.displayName ?? existing.displayName,
      baseUrl: patch.baseUrl ?? existing.baseUrl,
      credentialRef:
        patch.credentialRef === undefined ? existing.credentialRef : patch.credentialRef,
      allowPrivateNetwork: patch.allowPrivateNetwork ?? existing.allowPrivateNetwork,
      enabled: patch.enabled ?? existing.enabled,
    });
    if (!merged.success) {
      throw new StorageError('invalid', merged.error.issues.map((i) => i.message).join('; '));
    }
    const value = merged.data;
    this.#db
      .prepare(
        `UPDATE providers SET
           display_name = ?, base_url = ?, credential_ref = ?,
           allow_private_network = ?, enabled = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        value.displayName,
        value.baseUrl,
        value.credentialRef ?? null,
        value.allowPrivateNetwork === true ? 1 : 0,
        value.enabled === false ? 0 : 1,
        new Date().toISOString(),
        id,
      );
    return this.get(id) as ProviderRecord;
  }

  remove(id: string): boolean {
    const result = this.#db.prepare('DELETE FROM providers WHERE id = ?').run(id);
    return Number(result.changes) > 0;
  }
}
