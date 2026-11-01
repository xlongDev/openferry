import { afterEach, describe, expect, it } from 'vitest';
import { buildModelView, refreshModels } from '@openferry/model-registry';
import { openDatabase, type ModelRecord, type ProbeRecord } from '@openferry/storage';
import { OpenAICompatibleProvider } from '@openferry/provider-openai-compatible';
import { startFakeUpstream, type FakeUpstream } from '@openferry/testkit';

let upstream: FakeUpstream | null = null;

afterEach(async () => {
  await upstream?.close();
  upstream = null;
});

async function makeProvider(script: Parameters<typeof startFakeUpstream>[0]['script'] = undefined) {
  upstream = await startFakeUpstream(script === undefined ? {} : { script });
  return new OpenAICompatibleProvider({
    id: 'fake',
    baseUrl: upstream.url,
    apiKey: 'sk-test',
    allowPrivateNetwork: true,
  });
}

const modelList = (ids: string[]): Record<string, unknown> => ({
  object: 'list',
  data: ids.map((id) => ({ id, object: 'model', created: 1, owned_by: 'acme' })),
});

describe('refreshModels', () => {
  it('stores the catalogue and reports counts', async () => {
    const provider = await makeProvider([{ json: modelList(['alpha', 'beta']) }]);
    const db = openDatabase(':memory:');

    const results = await refreshModels([provider], db.models);
    expect(results).toEqual([{ providerId: 'fake', ok: true, added: 2, removed: 0, total: 2 }]);

    const models = db.models.list();
    expect(models.map((m) => m.id)).toEqual(['fake/alpha', 'fake/beta']);
    expect(models[0]?.source).toBe('upstream:/models');
    expect(models[0]?.pricing).toBeNull();
    db.close();
  });

  it('removes models the upstream no longer lists', async () => {
    const provider = await makeProvider([
      { json: modelList(['alpha', 'beta']) },
      { json: modelList(['beta']) },
    ]);
    const db = openDatabase(':memory:');

    await refreshModels([provider], db.models);
    const second = await refreshModels([provider], db.models);
    expect(second[0]).toMatchObject({ added: 0, removed: 1, total: 1 });
    expect(db.models.list().map((m) => m.id)).toEqual(['fake/beta']);
    db.close();
  });

  it('keeps the old catalogue when the upstream fails', async () => {
    const provider = await makeProvider([
      { json: modelList(['alpha']) },
      { status: 503, json: { error: {} } },
    ]);
    const db = openDatabase(':memory:');

    await refreshModels([provider], db.models);
    const failed = await refreshModels([provider], db.models);

    expect(failed[0]?.ok).toBe(false);
    expect(failed[0]?.error).toBeTruthy();
    expect(db.models.list().map((m) => m.id)).toEqual(['fake/alpha']);
    db.close();
  });
});

const baseModel: ModelRecord = {
  id: 'fake/alpha',
  providerId: 'fake',
  upstreamId: 'alpha',
  displayName: 'alpha',
  source: 'upstream:/models',
  observedAt: '2026-11-02T00:00:00.000Z',
  createdAt: 1,
  ownedBy: 'acme',
  pricing: null,
  lastProbedAt: null,
};

function probe(overrides: Partial<ProbeRecord>): ProbeRecord {
  return {
    id: 1,
    modelId: 'fake/alpha',
    probe: 'chat',
    status: 'pass',
    startedAt: '2026-11-02T00:00:00.000Z',
    durationMs: 100,
    expiresAt: '2026-11-02T06:00:00.000Z',
    probeVersion: '1.0.0',
    ...overrides,
  };
}

describe('buildModelView', () => {
  const now = new Date('2026-11-02T01:00:00.000Z');

  it('reports unknown capability and unknown price when nothing has been probed', () => {
    const view = buildModelView(baseModel, [], now);
    expect(view.accessible).toBeNull();
    expect(view.priceStatus).toBe('unknown');
    expect(view.capabilities).toEqual([]);
  });

  it('marks a passing probe as accessible and not expired', () => {
    const view = buildModelView(baseModel, [probe({})], now);
    expect(view.accessible).toBe(true);
    expect(view.capabilities[0]?.expired).toBe(false);
  });

  it('treats an expired probe as unknown, not as a capability', () => {
    const view = buildModelView(baseModel, [probe({ expiresAt: '2026-11-02T00:30:00.000Z' })], now);
    expect(view.accessible).toBeNull();
    expect(view.capabilities[0]?.expired).toBe(true);
  });

  it('marks a failed chat probe as not accessible', () => {
    const view = buildModelView(
      baseModel,
      [probe({ status: 'fail', errorCode: 'unauthorized' })],
      now,
    );
    expect(view.accessible).toBe(false);
    expect(view.capabilities[0]?.errorCode).toBe('unauthorized');
  });

  it('reports priced when pricing exists', () => {
    const view = buildModelView({ ...baseModel, pricing: { inputPerMTokens: 1 } }, [], now);
    expect(view.priceStatus).toBe('priced');
  });
});
