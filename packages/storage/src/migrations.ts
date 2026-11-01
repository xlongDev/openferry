import type { DatabaseSync } from 'node:sqlite';

/**
 * 版本化迁移。
 *
 * 规则：
 *  - 已发布的迁移**永不修改**，只能追加新版本
 *  - 每个版本在事务里执行，失败整体回滚
 *  - 迁移前的数据库文件由调用方备份（这里只保证事务原子性）
 */

export interface Migration {
  version: number;
  name: string;
  statements: string[];
}

export const migrations: Migration[] = [
  {
    version: 1,
    name: 'providers',
    statements: [
      `CREATE TABLE IF NOT EXISTS providers (
         id TEXT PRIMARY KEY,
         display_name TEXT NOT NULL,
         kind TEXT NOT NULL,
         base_url TEXT NOT NULL,
         credential_ref TEXT,
         allow_private_network INTEGER NOT NULL DEFAULT 0,
         enabled INTEGER NOT NULL DEFAULT 1,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS idx_providers_enabled ON providers (enabled)`,
    ],
  },
  {
    version: 2,
    name: 'models-and-probes',
    statements: [
      `CREATE TABLE IF NOT EXISTS models (
         id TEXT PRIMARY KEY,
         provider_id TEXT NOT NULL,
         upstream_id TEXT NOT NULL,
         display_name TEXT NOT NULL,
         source TEXT NOT NULL,
         observed_at TEXT NOT NULL,
         created_at INTEGER,
         owned_by TEXT,
         pricing_json TEXT,
         last_probed_at TEXT,
         UNIQUE (provider_id, upstream_id)
       )`,
      `CREATE INDEX IF NOT EXISTS idx_models_provider ON models (provider_id)`,
      `CREATE TABLE IF NOT EXISTS probe_runs (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         model_id TEXT NOT NULL,
         probe TEXT NOT NULL,
         status TEXT NOT NULL,
         started_at TEXT NOT NULL,
         duration_ms INTEGER NOT NULL,
         error_code TEXT,
         evidence TEXT,
         expires_at TEXT NOT NULL,
         probe_version TEXT NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS idx_probe_model ON probe_runs (model_id, probe, started_at DESC)`,
    ],
  },
];

export interface MigrationResult {
  from: number;
  to: number;
  applied: number[];
}

function currentVersion(db: DatabaseSync): number {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const row = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as
    { version: number | null } | undefined;
  return row?.version ?? 0;
}

export function migrate(db: DatabaseSync): MigrationResult {
  return applyMigrations(db, migrations);
}

/** 允许注入迁移列表，主要用于验证「失败回滚」。 */
export function applyMigrations(db: DatabaseSync, list: Migration[]): MigrationResult {
  const from = currentVersion(db);
  const pending = list
    .filter((migration) => migration.version > from)
    .sort((a, b) => a.version - b.version);

  const applied: number[] = [];
  for (const migration of pending) {
    db.exec('BEGIN');
    try {
      for (const statement of migration.statements) db.exec(statement);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        migration.version,
        migration.name,
        new Date().toISOString(),
      );
      db.exec('COMMIT');
      applied.push(migration.version);
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(
        `migration ${migration.version} (${migration.name}) failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
  }

  return { from, to: currentVersion(db), applied };
}
