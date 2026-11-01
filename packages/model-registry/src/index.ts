import type { ProviderAdapter } from '@openferry/provider-contract';
import type {
  ModelRecord,
  ModelRepository,
  ProbeKind,
  ProbeRecord,
  ProbeStatus,
} from '@openferry/storage';

/**
 * 模型目录。
 *
 * 一个容易做错的地方：刷新失败时**不能**清空已有目录。
 * 上游临时 503 不代表模型没了，删掉只会让 UI 骗人。
 */

export interface RefreshResult {
  providerId: string;
  ok: boolean;
  added: number;
  removed: number;
  total: number;
  error?: string;
}

export interface RefreshOptions {
  signal?: AbortSignal;
  requestId?: string;
  timeoutMs?: number;
}

export async function refreshModels(
  providers: ProviderAdapter[],
  repository: ModelRepository,
  options: RefreshOptions = {},
): Promise<RefreshResult[]> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const results: RefreshResult[] = [];

  await Promise.all(
    providers.map(async (provider) => {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(new Error('model refresh timeout')),
        timeoutMs,
      );
      timer.unref();
      const onOuter = (): void => controller.abort(options.signal?.reason);
      if (options.signal?.aborted) onOuter();
      else options.signal?.addEventListener('abort', onOuter, { once: true });

      try {
        const models = await provider.listModels({
          signal: controller.signal,
          requestId: options.requestId ?? 'model-refresh',
          timeouts: { connectMs: 8000, firstEventMs: 10_000, totalMs: timeoutMs },
        });

        const { added, removed } = repository.replaceForProvider(
          provider.id,
          models.map((model) => ({
            providerId: provider.id,
            upstreamId: model.upstreamId,
            displayName: model.displayName,
            source: model.source,
            observedAt: model.observedAt,
            ...(model.createdAt === undefined ? {} : { createdAt: model.createdAt }),
            ...(model.ownedBy === undefined ? {} : { ownedBy: model.ownedBy }),
            ...(model.pricing === undefined ? {} : { pricing: model.pricing }),
          })),
        );

        results.push({ providerId: provider.id, ok: true, added, removed, total: models.length });
      } catch (error) {
        // 保留旧目录，只报告失败。
        const existing = repository
          .list()
          .filter((model) => model.providerId === provider.id).length;
        results.push({
          providerId: provider.id,
          ok: false,
          added: 0,
          removed: 0,
          total: existing,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onOuter);
      }
    }),
  );

  return results.sort((a, b) => a.providerId.localeCompare(b.providerId));
}

export interface CapabilityView {
  probe: ProbeKind;
  status: ProbeStatus;
  expired: boolean;
  checkedAt: string;
  expiresAt: string;
  errorCode?: string;
  evidence?: string;
}

export interface ModelView extends ModelRecord {
  capabilities: CapabilityView[];
  /** 没有任何未过期的探测结果时为 null —— 「不知道」不是「不可用」。 */
  accessible: boolean | null;
  /** 价格未知就是 null，UI 必须显示「未知」而不是「免费」。 */
  priceStatus: 'unknown' | 'priced';
}

const CAPABILITY_ORDER: ProbeKind[] = ['chat', 'stream', 'tool_call', 'tool_args'];

export function buildModelView(
  model: ModelRecord,
  probes: ProbeRecord[],
  now: Date = new Date(),
): ModelView {
  const capabilities: CapabilityView[] = [];
  let accessible: boolean | null = null;

  for (const kind of CAPABILITY_ORDER) {
    const latest = probes.find((probe) => probe.probe === kind);
    if (!latest) continue;
    const expired = new Date(latest.expiresAt).getTime() <= now.getTime();
    capabilities.push({
      probe: latest.probe,
      status: latest.status,
      expired,
      checkedAt: latest.startedAt,
      expiresAt: latest.expiresAt,
      ...(latest.errorCode === undefined ? {} : { errorCode: latest.errorCode }),
      ...(latest.evidence === undefined ? {} : { evidence: latest.evidence }),
    });
    if (kind === 'chat' && !expired) accessible = latest.status === 'pass';
  }

  return {
    ...model,
    capabilities,
    accessible,
    priceStatus: model.pricing === null ? 'unknown' : 'priced',
  };
}

export function buildModelViews(
  models: ModelRecord[],
  probesByModel: Map<string, ProbeRecord[]>,
  now: Date = new Date(),
): ModelView[] {
  return models.map((model) => buildModelView(model, probesByModel.get(model.id) ?? [], now));
}
