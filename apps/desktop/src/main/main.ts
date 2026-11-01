import { app, BrowserWindow, ipcMain, safeStorage, shell, type IpcMainInvokeEvent } from 'electron';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createLogger, newToken, type LoggerHandle } from '@openferry/core';
import { createGateway, type Gateway, type GatewayStats } from '@openferry/gateway';
import { createProviders, loadConfigFile } from '@openferry/config-manager';
import {
  openDatabase,
  providerInputSchema,
  type OpenFerryDatabase,
  type ProviderRecord,
} from '@openferry/storage';
import type { SecretStore } from '@openferry/secrets';
import { OpenAICompatibleProvider } from '@openferry/provider-openai-compatible';
import type { ProviderAdapter } from '@openferry/provider-contract';
import { PROBE_VERSION, expiresAt, runAllProbes } from '@openferry/capability-probes';
import { buildModelViews, refreshModels, type ModelView } from '@openferry/model-registry';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(homedir(), '.openferry');
const CONFIG_PATH = join(DATA_DIR, 'config.json');
const TOKEN_PATH = join(DATA_DIR, 'token');
const DB_PATH = join(DATA_DIR, 'openferry.db');
const SECRETS_PATH = join(DATA_DIR, 'secrets.json');

type GatewayState = 'stopped' | 'starting' | 'running' | 'error';

interface StatusPayload {
  state: GatewayState;
  url: string | null;
  port: number | null;
  startedAt: string | null;
  requests: number;
  errors: number;
  inFlight: number;
  providers: string[];
  dataDir: string;
  configPath: string;
  configExists: boolean;
  lastError: string | null;
  version: string;
  schemaVersion: number;
  secretStore: SecretStore['kind'];
}

interface ProviderView extends ProviderRecord {
  /** 只表示「有没有存过密钥」，永远不返回密钥本身。 */
  hasCredential: boolean;
}

let db: OpenFerryDatabase | null = null;
let secrets: SecretStore;
let gateway: Gateway | null = null;
let state: GatewayState = 'stopped';
let lastError: string | null = null;
let currentUrl: string | null = null;
let mainWindow: BrowserWindow | null = null;
let quitting = false;

const logger: LoggerHandle = createLogger({ level: 'info', ringSize: 500, sink: () => {} });

/** 用系统凭据存储加密密钥；没有可用凭据存储时拒绝保存，而不是退回明文。 */
class SafeStorageSecretStore implements SecretStore {
  readonly kind = 'encrypted' as const;
  readonly #path: string;
  #available: boolean | null = null;

  constructor(path: string) {
    this.#path = path;
  }

  async #assertAvailable(): Promise<void> {
    this.#available ??= await safeStorage.isAsyncEncryptionAvailable();
    if (!this.#available) {
      throw new Error('系统凭据存储不可用，无法安全保存密钥');
    }
  }

  async #read(): Promise<Record<string, string>> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.#path, 'utf8'));
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
    const values = await this.#read();
    const blob = values[ref];
    if (blob === undefined) return undefined;
    try {
      const decrypted = await safeStorage.decryptStringAsync(Buffer.from(blob, 'base64'));
      // 系统密钥轮换后需要重新加密，否则每次读取都会走这条迁移路径。
      if (decrypted.shouldReEncrypt) {
        await this.set(ref, decrypted.result).catch(() => {});
      }
      return decrypted.result;
    } catch {
      logger.warn('secrets.decrypt_failed', { ref });
      return undefined;
    }
  }

  async set(ref: string, value: string): Promise<void> {
    await this.#assertAvailable();
    const values = await this.#read();
    const encrypted = await safeStorage.encryptStringAsync(value);
    values[ref] = encrypted.toString('base64');
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

async function loadOrCreateToken(): Promise<string> {
  try {
    const existing = (await readFile(TOKEN_PATH, 'utf8')).trim();
    if (existing.length >= 16) return existing;
  } catch {
    // 文件不存在，继续生成。
  }
  const token = newToken();
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(TOKEN_PATH, token, { encoding: 'utf8', mode: 0o600 });
  await chmod(TOKEN_PATH, 0o600).catch(() => {});
  return token;
}

async function buildAdapters(): Promise<ProviderAdapter[]> {
  if (!db) return [];
  const records = db.providers.list().filter((record) => record.enabled);
  const adapters: ProviderAdapter[] = [];

  for (const record of records) {
    const apiKey = record.credentialRef ? await secrets.get(record.credentialRef) : undefined;
    try {
      adapters.push(
        new OpenAICompatibleProvider({
          id: record.id,
          baseUrl: record.baseUrl,
          ...(apiKey === undefined ? {} : { apiKey }),
          allowPrivateNetwork: record.allowPrivateNetwork,
        }),
      );
    } catch (error) {
      // 一个供应商配置有问题不应该拖垮整个网关。
      logger.warn('provider.invalid', {
        providerId: record.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return adapters;
}

async function reloadProviders(): Promise<void> {
  if (!gateway) return;
  gateway.setProviders(await buildAdapters());
}

/** 首次运行且数据库为空时，把旧版 config.json 的供应商导入一次。 */
async function importLegacyConfig(): Promise<void> {
  if (!db || !existsSync(CONFIG_PATH)) return;
  if (db.providers.list().length > 0) return;

  try {
    const config = await loadConfigFile(CONFIG_PATH);
    if (config.providers.length === 0) return;
    createProviders(config.providers); // 只用来触发一次 URL 校验，结果不参与导入

    for (const entry of config.providers) {
      const envValue = entry.apiKeyEnv === undefined ? undefined : process.env[entry.apiKeyEnv];
      const credentialRef = envValue === undefined ? null : entry.id;
      if (credentialRef !== null && envValue !== undefined) {
        await secrets.set(credentialRef, envValue).catch((error: unknown) => {
          logger.warn('provider.import_credential_failed', {
            providerId: entry.id,
            message: String(error),
          });
        });
      }
      db.providers.create({
        id: entry.id,
        displayName: entry.id,
        baseUrl: entry.baseUrl,
        credentialRef,
        allowPrivateNetwork: entry.allowPrivateNetwork === true,
      });
    }

    logger.info('providers.imported_from_config', { count: config.providers.length });
  } catch (error) {
    logger.warn('providers.import_failed', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function stats(): GatewayStats | null {
  return gateway?.stats() ?? null;
}

function status(): StatusPayload {
  const current = stats();
  return {
    state,
    url: currentUrl,
    port: current?.port ?? null,
    startedAt: current?.startedAt ?? null,
    requests: current?.requests ?? 0,
    errors: current?.errors ?? 0,
    inFlight: current?.inFlight ?? 0,
    providers: current?.providers ?? [],
    dataDir: DATA_DIR,
    configPath: CONFIG_PATH,
    configExists: existsSync(CONFIG_PATH),
    lastError,
    version: app.getVersion(),
    schemaVersion: db?.schemaVersion() ?? 0,
    secretStore: secrets.kind,
  };
}

async function startGateway(): Promise<StatusPayload> {
  if (state === 'running' || state === 'starting') return status();
  state = 'starting';
  lastError = null;

  try {
    const port = existsSync(CONFIG_PATH) ? (await loadConfigFile(CONFIG_PATH)).port : 41980;
    const token = await loadOrCreateToken();
    gateway = createGateway({
      providers: await buildAdapters(),
      token,
      host: '127.0.0.1',
      port,
      logger,
    });

    const { url } = await gateway.start();
    currentUrl = url;
    state = 'running';
  } catch (error) {
    state = 'error';
    gateway = null;
    currentUrl = null;
    lastError = error instanceof Error ? error.message : String(error);
    logger.error('gateway.start_failed', { message: lastError });
  }

  return status();
}

async function stopGateway(): Promise<StatusPayload> {
  if (gateway) {
    await gateway.stop().catch((error: unknown) => {
      logger.warn('gateway.stop_failed', { message: String(error) });
    });
  }
  gateway = null;
  currentUrl = null;
  state = 'stopped';
  return status();
}

async function restartGateway(): Promise<StatusPayload> {
  await stopGateway();
  return startGateway();
}

function requireDb(): OpenFerryDatabase {
  if (!db) throw new Error('database is not open');
  return db;
}

async function listProviders(): Promise<ProviderView[]> {
  const records = requireDb().providers.list();
  const stored = new Set(await secrets.list());
  return records.map((record) => ({
    ...record,
    hasCredential: record.credentialRef !== null && stored.has(record.credentialRef),
  }));
}

async function listModels(): Promise<ModelView[]> {
  const database = requireDb();
  const models = database.models.list();
  const probes = new Map(
    models.map((model) => [model.id, database.probes.latestForModel(model.id)]),
  );
  return buildModelViews(models, probes);
}

const createPayloadSchema = providerInputSchema.extend({ apiKey: z.string().max(4096).optional() });

const updatePayloadSchema = z.object({
  id: z.string().min(1),
  patch: z.object({
    displayName: z.string().min(1).max(120).optional(),
    baseUrl: z.string().min(1).max(2048).optional(),
    allowPrivateNetwork: z.boolean().optional(),
    enabled: z.boolean().optional(),
  }),
  /** undefined = 不改；空串 = 清除；其他 = 覆盖。 */
  apiKey: z.string().max(4096).optional(),
});

const testPayloadSchema = z.object({
  id: z.string().min(1).max(64).optional(),
  baseUrl: z.string().min(1).max(2048),
  apiKey: z.string().max(4096).optional(),
  allowPrivateNetwork: z.boolean().optional(),
});

interface TestResult {
  ok: boolean;
  models: number;
  durationMs: number;
  error?: string;
}

async function testProvider(payload: unknown): Promise<TestResult> {
  const parsed = testPayloadSchema.parse(payload);
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  timer.unref();

  try {
    const adapter = new OpenAICompatibleProvider({
      id: parsed.id ?? 'draft',
      baseUrl: parsed.baseUrl,
      ...(parsed.apiKey === undefined || parsed.apiKey.length === 0
        ? {}
        : { apiKey: parsed.apiKey }),
      allowPrivateNetwork: parsed.allowPrivateNetwork === true,
    });
    const models = await adapter.listModels({
      signal: controller.signal,
      requestId: 'provider-test',
      timeouts: { connectMs: 8000, firstEventMs: 10_000, totalMs: 10_000 },
    });
    return { ok: true, models: models.length, durationMs: Date.now() - started };
  } catch (error) {
    return {
      ok: false,
      models: 0,
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const url = event.senderFrame?.url ?? '';
  const devUrl = process.env['OPENFERRY_DEV_URL'];
  const trusted = devUrl !== undefined ? url.startsWith(devUrl) : url.startsWith('file://');
  if (!trusted) {
    throw new Error(`untrusted IPC sender: ${url}`);
  }
}

function registerIpc(): void {
  const guarded = (channel: string, handler: (payload: unknown) => Promise<unknown> | unknown) => {
    ipcMain.handle(channel, async (event, payload: unknown) => {
      assertTrustedSender(event);
      return handler(payload);
    });
  };

  guarded('gateway:status', async () => status());
  guarded('gateway:start', async () => startGateway());
  guarded('gateway:stop', async () => stopGateway());
  guarded('gateway:restart', async () => restartGateway());
  guarded('app:info', async () => ({
    version: app.getVersion(),
    dataDir: DATA_DIR,
    configPath: CONFIG_PATH,
  }));
  guarded('app:open-data-dir', async () => {
    await shell.openPath(DATA_DIR);
    return { ok: true };
  });

  ipcMain.handle('logs:recent', async (event, payload: unknown) => {
    assertTrustedSender(event);
    const parsed = z.object({ limit: z.number().int().min(1).max(500) }).safeParse(payload);
    if (!parsed.success) throw new Error('invalid logs:recent payload');
    return logger.recent(parsed.data.limit);
  });

  guarded('providers:list', async () => listProviders());

  guarded('providers:create', async (payload) => {
    const parsed = createPayloadSchema.parse(payload);
    const { apiKey, ...input } = parsed;
    const credentialRef = apiKey !== undefined && apiKey.length > 0 ? input.id : null;
    if (credentialRef !== null && apiKey !== undefined) await secrets.set(credentialRef, apiKey);
    requireDb().providers.create({ ...input, credentialRef });
    await reloadProviders();
    return listProviders();
  });

  guarded('providers:update', async (payload) => {
    const parsed = updatePayloadSchema.parse(payload);
    const before = requireDb().providers.get(parsed.id);
    if (!before) throw new Error(`供应商 ${parsed.id} 不存在`);

    if (parsed.apiKey !== undefined) {
      if (parsed.apiKey.length === 0) {
        await secrets.delete(parsed.id);
        requireDb().providers.update(parsed.id, { credentialRef: null });
      } else {
        await secrets.set(parsed.id, parsed.apiKey);
        requireDb().providers.update(parsed.id, { credentialRef: parsed.id });
      }
    }
    requireDb().providers.update(parsed.id, parsed.patch);

    // 换了端点，旧的能力结论对应的是另一个上游，必须作废。
    const endpointChanged =
      (parsed.patch.baseUrl !== undefined && parsed.patch.baseUrl !== before.baseUrl) ||
      (parsed.patch.allowPrivateNetwork !== undefined &&
        parsed.patch.allowPrivateNetwork !== before.allowPrivateNetwork);
    if (endpointChanged) {
      requireDb().probes.deleteForProvider(parsed.id);
      requireDb().models.removeForProvider(parsed.id);
    }

    await reloadProviders();
    return listProviders();
  });

  guarded('providers:remove', async (payload) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(payload);
    await secrets.delete(id);
    requireDb().probes.deleteForProvider(id);
    requireDb().providers.remove(id);
    requireDb().models.removeForProvider(id);
    await reloadProviders();
    return listProviders();
  });

  guarded('providers:test', async (payload) => testProvider(payload));

  guarded('models:list', async () => listModels());

  guarded('models:refresh', async () => {
    const results = await refreshModels(await buildAdapters(), requireDb().models);
    return { results, models: await listModels() };
  });

  guarded('models:probe', async (payload) => {
    const { modelId } = z.object({ modelId: z.string().min(1).max(300) }).parse(payload);
    const database = requireDb();
    const model = database.models.get(modelId);
    if (!model) throw new Error(`模型 ${modelId} 不在目录里，先刷新一次目录`);

    const adapter = (await buildAdapters()).find((item) => item.id === model.providerId);
    if (!adapter) throw new Error(`供应商 ${model.providerId} 未启用，无法检测`);

    const outcomes = await runAllProbes(adapter, modelId, { requestId: `probe-${Date.now()}` });
    const startedAt = new Date().toISOString();

    for (const outcome of outcomes) {
      database.probes.record({
        modelId,
        probe: outcome.probe,
        status: outcome.status,
        startedAt,
        durationMs: outcome.durationMs,
        ...(outcome.errorCode === undefined ? {} : { errorCode: outcome.errorCode }),
        ...(outcome.evidence === undefined ? {} : { evidence: outcome.evidence }),
        expiresAt: expiresAt(outcome.status, outcome.errorCode),
        probeVersion: PROBE_VERSION,
      });
    }
    database.models.markProbed(modelId, startedAt);

    return listModels();
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 880,
    minHeight: 560,
    backgroundColor: '#0b0c0e',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    show: false,
    webPreferences: {
      preload: join(HERE, '../../preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  const devUrl = process.env['OPENFERRY_DEV_URL'];
  if (devUrl !== undefined) {
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadFile(join(HERE, '../renderer/index.html'));
  }

  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  await mkdir(DATA_DIR, { recursive: true });
  db = openDatabase(DB_PATH);
  secrets = new SafeStorageSecretStore(SECRETS_PATH);
  if (!(await safeStorage.isAsyncEncryptionAvailable())) {
    logger.warn('secrets.unavailable', { message: '系统凭据存储不可用，密钥无法保存' });
  }

  await importLegacyConfig();
  registerIpc();
  await startGateway();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  if (quitting || !gateway) {
    db?.close();
    return;
  }
  event.preventDefault();
  quitting = true;
  void gateway.stop().finally(() => {
    db?.close();
    app.quit();
  });
});
