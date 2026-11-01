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
  schemaVersion: number;
  secretStore: 'encrypted' | 'file' | 'memory';
}

export interface LogRecord {
  ts: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  event: string;
  [key: string]: unknown;
}

export interface ProviderView {
  id: string;
  displayName: string;
  kind: 'openai-compatible';
  baseUrl: string;
  credentialRef: string | null;
  allowPrivateNetwork: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  hasCredential: boolean;
}

export interface ProviderDraft {
  id: string;
  displayName: string;
  baseUrl: string;
  apiKey: string;
  allowPrivateNetwork: boolean;
}

export interface ProviderTestResult {
  ok: boolean;
  models: number;
  durationMs: number;
  error?: string;
}

export interface OpenFerryApi {
  getStatus(): Promise<StatusPayload>;
  start(): Promise<StatusPayload>;
  stop(): Promise<StatusPayload>;
  restart(): Promise<StatusPayload>;
  recentLogs(limit: number): Promise<LogRecord[]>;
  appInfo(): Promise<{ version: string; dataDir: string; configPath: string }>;
  openDataDir(): Promise<{ ok: boolean }>;
  providers: {
    list(): Promise<ProviderView[]>;
    create(input: ProviderDraft): Promise<ProviderView[]>;
    update(input: {
      id: string;
      patch: {
        displayName?: string;
        baseUrl?: string;
        allowPrivateNetwork?: boolean;
        enabled?: boolean;
      };
      apiKey?: string;
    }): Promise<ProviderView[]>;
    remove(id: string): Promise<ProviderView[]>;
    test(input: {
      id?: string;
      baseUrl: string;
      apiKey?: string;
      allowPrivateNetwork?: boolean;
    }): Promise<ProviderTestResult>;
  };
}

declare global {
  interface Window {
    openferry: OpenFerryApi;
  }
}
