import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * 密钥存储的抽象。
 *
 * 关键约束：数据库只存 `credentialRef`（引用名），密钥本体只经过这里。
 * 桌面端用 Electron `safeStorage`（Keychain / DPAPI）实现；
 * CLI 用 `FileSecretStore`，它是**明文**的，只作为无 GUI 环境下的兜底。
 */

export type SecretStoreKind = 'encrypted' | 'file' | 'memory';

export interface SecretStore {
  readonly kind: SecretStoreKind;
  get(ref: string): Promise<string | undefined>;
  set(ref: string, value: string): Promise<void>;
  delete(ref: string): Promise<void>;
  /** 只返回引用名，永远不返回值。 */
  list(): Promise<string[]>;
}

export class MemorySecretStore implements SecretStore {
  readonly kind = 'memory' as const;
  readonly #values = new Map<string, string>();

  async get(ref: string): Promise<string | undefined> {
    return this.#values.get(ref);
  }

  async set(ref: string, value: string): Promise<void> {
    this.#values.set(ref, value);
  }

  async delete(ref: string): Promise<void> {
    this.#values.delete(ref);
  }

  async list(): Promise<string[]> {
    return [...this.#values.keys()].sort();
  }
}

/**
 * 明文文件兜底（权限 0600）。**不加密**，只在没有 OS 凭据存储时使用。
 * 调用方必须在启动日志里明确告警。
 */
export class FileSecretStore implements SecretStore {
  readonly kind = 'file' as const;
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  async #read(): Promise<Record<string, string>> {
    try {
      const raw = await readFile(this.#path, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return {};
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'string') out[key] = value;
      }
      return out;
    } catch {
      return {};
    }
  }

  async #write(values: Record<string, string>): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    const temp = `${this.#path}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(values, null, 2), { encoding: 'utf8', mode: 0o600 });
    await chmod(temp, 0o600).catch(() => {});
    await rename(temp, this.#path);
  }

  async get(ref: string): Promise<string | undefined> {
    return (await this.#read())[ref];
  }

  async set(ref: string, value: string): Promise<void> {
    const values = await this.#read();
    values[ref] = value;
    await this.#write(values);
  }

  async delete(ref: string): Promise<void> {
    const values = await this.#read();
    if (!(ref in values)) return;
    delete values[ref];
    await this.#write(values);
  }

  async list(): Promise<string[]> {
    return Object.keys(await this.#read()).sort();
  }
}
