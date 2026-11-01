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

export type ProbeKind = 'chat' | 'stream' | 'tool_call' | 'tool_args';
export type ProbeStatus = 'pass' | 'fail' | 'unsupported';

export interface CapabilityView {
  probe: ProbeKind;
  status: ProbeStatus;
  expired: boolean;
  checkedAt: string;
  expiresAt: string;
  errorCode?: string;
  evidence?: string;
}

export interface ModelView {
  id: string;
  providerId: string;
  upstreamId: string;
  displayName: string;
  source: string;
  observedAt: string;
  createdAt: number | null;
  ownedBy: string | null;
  pricing: { inputPerMTokens?: number; outputPerMTokens?: number; currency?: string } | null;
  lastProbedAt: string | null;
  capabilities: CapabilityView[];
  accessible: boolean | null;
  priceStatus: 'unknown' | 'priced';
}

export interface RefreshResult {
  providerId: string;
  ok: boolean;
  added: number;
  removed: number;
  total: number;
  error?: string;
}

export interface ClientEntry {
  id: string;
  [key: string]: unknown;
}

export interface ClientState {
  clientId: string;
  displayName: string;
  path: string;
  exists: boolean;
  readable: boolean;
  entryCount: number;
  entries: ClientEntry[];
  hash: string | null;
  error?: string;
  ownedIds: string[];
  backups: Array<{ name: string; createdAt: string; size: number }>;
  gatewayUrl: string | null;
  gatewayRunning: boolean;
}

export type PlanAction = 'add' | 'update' | 'remove' | 'unchanged' | 'conflict';

export interface PlanItem {
  id: string;
  action: PlanAction;
  before: ClientEntry | null;
  after: ClientEntry | null;
  note?: string;
}

export interface ClientPlan {
  clientId: string;
  path: string;
  baseHash: string | null;
  items: PlanItem[];
  nextContent: string;
  warnings: string[];
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
  clients: {
    state(): Promise<ClientState>;
    preview(modelIds: string[]): Promise<ClientPlan>;
    apply(modelIds: string[]): Promise<{ state: ClientState }>;
    restore(name: string): Promise<ClientState>;
  };
  models: {
    list(): Promise<ModelView[]>;
    refresh(): Promise<{ results: RefreshResult[]; models: ModelView[] }>;
    probe(modelId: string): Promise<ModelView[]>;
  };
}

declare global {
  interface Window {
    openferry: OpenFerryApi;
  }
}
