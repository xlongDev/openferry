import type { DatabaseSync } from 'node:sqlite';

/**
 * 客户端条目归属。
 *
 * 为什么不写在 models.json 里加个 `openferry: true` 字段：
 * 那是用户的配置文件，加私有字段等于污染；而且字段一旦被客户端忽略，
 * 我们就失去了唯一能区分「我们写的」和「用户手写的」的依据。
 */
export class ClientEntryRepository {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  list(clientId: string): string[] {
    const rows = this.#db
      .prepare('SELECT entry_id FROM client_entries WHERE client_id = ? ORDER BY entry_id ASC')
      .all(clientId) as unknown as Array<{ entry_id: string }>;
    return rows.map((row) => row.entry_id);
  }

  /** 整体替换某个客户端的归属集合。 */
  replace(clientId: string, entryIds: string[]): void {
    this.#db.exec('BEGIN');
    try {
      this.#db.prepare('DELETE FROM client_entries WHERE client_id = ?').run(clientId);
      const insert = this.#db.prepare(
        'INSERT INTO client_entries (client_id, entry_id, written_at) VALUES (?, ?, ?)',
      );
      const now = new Date().toISOString();
      for (const id of new Set(entryIds)) insert.run(clientId, id, now);
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  /** 只保留仍然存在于客户端文件里的归属记录。 */
  retain(clientId: string, presentIds: ReadonlySet<string>): string[] {
    const kept = this.list(clientId).filter((id) => presentIds.has(id));
    this.replace(clientId, kept);
    return kept;
  }
}
