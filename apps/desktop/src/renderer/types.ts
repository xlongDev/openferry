export interface StatusPayload {
  state: 'stopped' | 'starting' | 'running' | 'error';
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

export interface LogRecord {
  ts: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  event: string;
  [key: string]: unknown;
}

export interface OpenFerryApi {
  getStatus(): Promise<StatusPayload>;
  start(): Promise<StatusPayload>;
  stop(): Promise<StatusPayload>;
  restart(): Promise<StatusPayload>;
  recentLogs(limit: number): Promise<LogRecord[]>;
  appInfo(): Promise<{ version: string; dataDir: string; configPath: string }>;
  openDataDir(): Promise<{ ok: boolean }>;
}

declare global {
  interface Window {
    openferry: OpenFerryApi;
  }
}
