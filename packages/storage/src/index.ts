import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  applyMigrations,
  migrate,
  migrations,
  type Migration,
  type MigrationResult,
} from './migrations.js';
import {
  ProviderRepository,
  StorageError,
  providerInputSchema,
  type ProviderInput,
  type ProviderRecord,
} from './providers.js';
import { ClientEntryRepository } from './client-entries.js';
import {
  ModelRepository,
  ProbeRepository,
  type ModelInput,
  type ModelPricing,
  type ModelRecord,
  type ProbeInput,
  type ProbeKind,
  type ProbeRecord,
  type ProbeStatus,
} from './models.js';

export {
  migrate,
  applyMigrations,
  migrations,
  ProviderRepository,
  ModelRepository,
  ProbeRepository,
  ClientEntryRepository,
  StorageError,
  providerInputSchema,
  type Migration,
  type MigrationResult,
  type ProviderInput,
  type ProviderRecord,
  type ModelInput,
  type ModelPricing,
  type ModelRecord,
  type ProbeInput,
  type ProbeKind,
  type ProbeRecord,
  type ProbeStatus,
};

export interface OpenFerryDatabase {
  readonly raw: DatabaseSync;
  readonly providers: ProviderRepository;
  readonly models: ModelRepository;
  readonly probes: ProbeRepository;
  readonly clientEntries: ClientEntryRepository;
  /** 当前 schema 版本，用于诊断信息。 */
  schemaVersion(): number;
  close(): void;
}

export function openDatabase(path: string): OpenFerryDatabase {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');

  const result = migrate(db);

  return {
    raw: db,
    providers: new ProviderRepository(db),
    models: new ModelRepository(db),
    probes: new ProbeRepository(db),
    clientEntries: new ClientEntryRepository(db),
    schemaVersion() {
      return result.to;
    },
    close() {
      db.close();
    },
  };
}
