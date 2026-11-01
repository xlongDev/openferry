import { app, BrowserWindow, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createLogger, newToken, type LoggerHandle } from '@openferry/core';
import { createGateway, type Gateway, type GatewayStats } from '@openferry/gateway';
import { createProviders, loadConfigFile, type ConfigFile } from '@openferry/config-manager';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(homedir(), '.openferry');
const CONFIG_PATH = join(DATA_DIR, 'config.json');
const TOKEN_PATH = join(DATA_DIR, 'token');

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
}

let gateway: Gateway | null = null;
let state: GatewayState = 'stopped';
let lastError: string | null = null;
let currentUrl: string | null = null;
let mainWindow: BrowserWindow | null = null;
let quitting = false;

const logger: LoggerHandle = createLogger({ level: 'info', ringSize: 500, sink: () => {} });

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

async function loadConfig(): Promise<ConfigFile> {
  if (!existsSync(CONFIG_PATH)) {
    return {
      host: '127.0.0.1',
      port: 41980,
      maxConcurrency: 16,
      maxBodyBytes: 1024 * 1024,
      providers: [],
    };
  }
  return loadConfigFile(CONFIG_PATH);
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
  };
}

async function startGateway(): Promise<StatusPayload> {
  if (state === 'running' || state === 'starting') return status();
  state = 'starting';
  lastError = null;

  try {
    const config = await loadConfig();
    const { providers, warnings } = createProviders(config.providers);
    for (const warning of warnings) {
      logger.warn('provider.missing_credential', {
        providerId: warning.providerId,
        message: warning.message,
      });
    }

    const token = await loadOrCreateToken();
    gateway = createGateway({
      providers,
      token,
      host: '127.0.0.1',
      port: config.port,
      maxConcurrency: config.maxConcurrency,
      maxBodyBytes: config.maxBodyBytes,
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

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const url = event.senderFrame?.url ?? '';
  const devUrl = process.env['OPENFERRY_DEV_URL'];
  const trusted = devUrl !== undefined ? url.startsWith(devUrl) : url.startsWith('file://');
  if (!trusted) {
    throw new Error(`untrusted IPC sender: ${url}`);
  }
}

function registerIpc(): void {
  const guarded = <T>(channel: string, handler: (payload: T) => Promise<unknown> | unknown) => {
    ipcMain.handle(channel, async (event, payload: unknown) => {
      assertTrustedSender(event);
      return handler(payload as T);
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

  // 任何导航与新窗口都拒绝：应用界面只来自本地构建产物。
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  registerIpc();
  await mkdir(DATA_DIR, { recursive: true });
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
  if (quitting || !gateway) return;
  event.preventDefault();
  quitting = true;
  void gateway.stop().finally(() => app.quit());
});
