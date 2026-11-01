import type { DatabaseSync } from 'node:sqlite';

/**
 * 模型目录与探测结果。
 *
 * 两条原则写在这里，因为它们决定了 UI 的措辞：
 *  1. `pricing` 为 null 表示**价格未知**，不是「免费」。绝不把未知当 0。
 *  2. 探测结果是**带有效期的事实**，不是永久能力。过期就得重测。
 */

export interface ModelPricing {
  inputPerMTokens?: number;
  outputPerMTokens?: number;
  currency?: string;
}

export interface ModelInput {
  providerId: string;
  upstreamId: string;
  displayName: string;
  source: string;
  observedAt: string;
  createdAt?: number;
  ownedBy?: string;
  pricing?: ModelPricing;
}

export interface ModelRecord {
  id: string;
  providerId: string;
  upstreamId: string;
  displayName: string;
  source: string;
  observedAt: string;
  createdAt: number | null;
  ownedBy: string | null;
  pricing: ModelPricing | null;
  lastProbedAt: string | null;
}

export type ProbeKind = 'chat' | 'stream' | 'tool_call' | 'tool_args';
export type ProbeStatus = 'pass' | 'fail' | 'unsupported';

export interface ProbeInput {
  modelId: string;
  probe: ProbeKind;
  status: ProbeStatus;
  startedAt: string;
  durationMs: number;
  errorCode?: string;
  evidence?: string;
  expiresAt: string;
  probeVersion: string;
}

export interface ProbeRecord extends ProbeInput {
  id: number;
}

interface ModelRow {
  id: string;
  provider_id: string;
  upstream_id: string;
  display_name: string;
  source: string;
  observed_at: string;
  created_at: number | null;
  owned_by: string | null;
  pricing_json: string | null;
  last_probed_at: string | null;
}

interface ProbeRow {
  id: number;
  model_id: string;
  probe: string;
  status: string;
  started_at: string;
  duration_ms: number;
  error_code: string | null;
  evidence: string | null;
  expires_at: string;
  probe_version: string;
}

function parsePricing(raw: string | null): ModelPricing | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as ModelPricing) : null;
  } catch {
    return null;
  }
}

function toModel(row: ModelRow): ModelRecord {
  return {
    id: row.id,
    providerId: row.provider_id,
    upstreamId: row.upstream_id,
    displayName: row.display_name,
    source: row.source,
    observedAt: row.observed_at,
    createdAt: row.created_at,
    ownedBy: row.owned_by,
    pricing: parsePricing(row.pricing_json),
    lastProbedAt: row.last_probed_at,
  };
}

function toProbe(row: ProbeRow): ProbeRecord {
  return {
    id: row.id,
    modelId: row.model_id,
    probe: row.probe as ProbeKind,
    status: row.status as ProbeStatus,
    startedAt: row.started_at,
    durationMs: row.duration_ms,
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
    ...(row.evidence === null ? {} : { evidence: row.evidence }),
    expiresAt: row.expires_at,
    probeVersion: row.probe_version,
  };
}

export class ModelRepository {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  list(): ModelRecord[] {
    const rows = this.#db
      .prepare('SELECT * FROM models ORDER BY provider_id ASC, upstream_id ASC')
      .all() as unknown as ModelRow[];
    return rows.map(toModel);
  }

  get(id: string): ModelRecord | null {
    const row = this.#db.prepare('SELECT * FROM models WHERE id = ?').get(id) as unknown as
      ModelRow | undefined;
    return row ? toModel(row) : null;
  }

  /** 用一次目录刷新替换某个供应商的模型集合，返回变化数量。 */
  replaceForProvider(providerId: string, models: ModelInput[]): { added: number; removed: number } {
    const existing = new Set(
      (
        this.#db
          .prepare('SELECT id FROM models WHERE provider_id = ?')
          .all(providerId) as unknown as Array<{
          id: string;
        }>
      ).map((row) => row.id),
    );

    let added = 0;
    const upsert = this.#db.prepare(
      `INSERT INTO models (id, provider_id, upstream_id, display_name, source, observed_at, created_at, owned_by, pricing_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         display_name = excluded.display_name,
         source = excluded.source,
         observed_at = excluded.observed_at,
         created_at = excluded.created_at,
         owned_by = excluded.owned_by,
         pricing_json = excluded.pricing_json`,
    );

    for (const model of models) {
      const id = `${model.providerId}/${model.upstreamId}`;
      if (!existing.has(id)) added += 1;
      existing.delete(id);
      upsert.run(
        id,
        model.providerId,
        model.upstreamId,
        model.displayName,
        model.source,
        model.observedAt,
        model.createdAt ?? null,
        model.ownedBy ?? null,
        model.pricing === undefined ? null : JSON.stringify(model.pricing),
      );
    }

    // 剩下的是上游已经不再列出的模型。
    const remove = this.#db.prepare('DELETE FROM models WHERE id = ?');
    let removed = 0;
    for (const id of existing) {
      remove.run(id);
      removed += 1;
    }

    return { added, removed };
  }

  removeForProvider(providerId: string): number {
    const result = this.#db.prepare('DELETE FROM models WHERE provider_id = ?').run(providerId);
    return Number(result.changes);
  }

  markProbed(modelId: string, at: string): void {
    this.#db.prepare('UPDATE models SET last_probed_at = ? WHERE id = ?').run(at, modelId);
  }
}

export class ProbeRepository {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  record(input: ProbeInput): ProbeRecord {
    const result = this.#db
      .prepare(
        `INSERT INTO probe_runs
           (model_id, probe, status, started_at, duration_ms, error_code, evidence, expires_at, probe_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.modelId,
        input.probe,
        input.status,
        input.startedAt,
        input.durationMs,
        input.errorCode ?? null,
        input.evidence ?? null,
        input.expiresAt,
        input.probeVersion,
      );
    return { ...input, id: Number(result.lastInsertRowid) };
  }

  /** 每个探测类型取最新一条（可能已过期，由调用方判断）。 */
  latestForModel(modelId: string): ProbeRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT p.* FROM probe_runs p
         JOIN (SELECT probe, MAX(id) AS max_id FROM probe_runs WHERE model_id = ? GROUP BY probe) latest
           ON p.id = latest.max_id
         ORDER BY p.probe ASC`,
      )
      .all(modelId) as unknown as ProbeRow[];
    return rows.map(toProbe);
  }

  historyForModel(modelId: string, limit = 20): ProbeRecord[] {
    const rows = this.#db
      .prepare('SELECT * FROM probe_runs WHERE model_id = ? ORDER BY id DESC LIMIT ?')
      .all(modelId, limit) as unknown as ProbeRow[];
    return rows.map(toProbe);
  }

  /** 清掉过期很久的历史，避免表无限增长。 */
  prune(olderThanIso: string): number {
    const result = this.#db
      .prepare('DELETE FROM probe_runs WHERE expires_at < ?')
      .run(olderThanIso);
    return Number(result.changes);
  }

  /**
   * 删除某个供应商的全部探测记录。
   *
   * 必须做：删掉供应商再加回来（或改了 baseUrl）时，旧结论对应的是另一个端点，
   * 留着它会让 UI 显示一个不成立的「可用」。用前缀匹配而不是子查询，
   * 这样调用顺序不影响结果。
   */
  deleteForProvider(providerId: string): number {
    const result = this.#db
      .prepare('DELETE FROM probe_runs WHERE model_id LIKE ?')
      .run(`${providerId}/%`);
    return Number(result.changes);
  }
}
