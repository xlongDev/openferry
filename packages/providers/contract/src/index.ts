import type {
  CanonicalEvent,
  CanonicalRequest,
  CanonicalResponse,
  ModelDescriptor,
  ProviderCapabilities,
} from '@openferry/canonical';

export interface ProviderTimeouts {
  connectMs: number;
  firstEventMs: number;
  totalMs: number;
}

export interface ProviderContext {
  /** 客户端断开、网关关闭、总超时都会触发它。适配器必须把它接到 fetch 上。 */
  signal: AbortSignal;
  requestId: string;
  timeouts: ProviderTimeouts;
}

export interface ProviderAdapter {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  listModels(context: ProviderContext): Promise<ModelDescriptor[]>;
  send(request: CanonicalRequest, context: ProviderContext): Promise<CanonicalResponse>;
  stream(request: CanonicalRequest, context: ProviderContext): AsyncIterable<CanonicalEvent>;
}

export const defaultTimeouts: ProviderTimeouts = {
  connectMs: 10_000,
  firstEventMs: 30_000,
  totalMs: 300_000,
};
