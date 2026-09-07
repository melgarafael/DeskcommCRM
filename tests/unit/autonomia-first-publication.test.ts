import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ channels: vi.fn(), publish: vi.fn(), platformKey: vi.fn() }));
vi.mock('@/lib/channels/selectable', () => ({ listSelectableChannels: mocks.channels }));
vi.mock('@/lib/ai/agents/publish', () => ({ publishAgentVersion: mocks.publish }));
vi.mock('@/lib/ai/runtime/agent', () => ({ chaveDePlataforma: mocks.platformKey }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }));

import { publishFirstVersion } from '@/lib/ai/agents/first-publication';

const org = 'org-A', agentId = 'agent-A', user = 'admin-A';
const selection = { channelId: 'channel-A', provider: 'openai', model: 'model-A', credentialId: 'credential-A' };
type Row = Record<string, unknown> & { id: string };

/** Stateful PostgREST seam: retries see the exact draft persisted by the first call. */
function database(existing: Row[] = []) {
  const versions = structuredClone(existing);
  const legacyConfig = { rag_top_k: 9, guardrails: { enabled: true }, active_kb_version_id: 'kb-original' };
  const agent = { id: agentId, published_version_id: null as string | null, config: legacyConfig };
  const mutations: Array<{ table: string; values: Record<string, unknown> }> = [];
  const admin = { from(table: string) {
    const filters: Record<string, unknown> = {};
    let inserted: Record<string, unknown> | undefined;
    const result = () => {
      if (table === 'organizations') return { data: { settings: { llm: { provider: 'anthropic' } } }, error: null };
      if (table === 'ai_models') return { data: [{ model_id: 'model-A', supports_tools: true, is_default_for_provider: true }], error: null };
      if (table === 'crm_pipelines') return { data: { id: 'default-pipeline' }, error: null };
      if (table === 'ai_provider_credentials') return { data: { id: 'credential-A' }, error: null };
      if (table === 'ai_agents') {
        expect(filters).toMatchObject({ organization_id: org, id: agentId });
        return { data: { ...agent }, error: null };
      }
      if (table === 'ai_agent_versions') {
        if (inserted) {
          expect(inserted).toMatchObject({ organization_id: org, agent_id: agentId });
          if (versions.some(v => v.version_number === inserted!.version_number))
            return { data: null, error: { code: '23505', message: 'duplicate version number' } };
          const row = { ...structuredClone(inserted), id: 'version-own' };
          versions.push(row); mutations.push({ table, values: structuredClone(inserted) });
          return { data: { id: row.id }, error: null };
        }
        expect(filters).toMatchObject({ organization_id: org, agent_id: agentId });
        return { data: structuredClone(versions), error: null };
      }
      throw new Error(`Unexpected table ${table}`);
    };
    const builder = {
      select: (_columns?: string) => builder,
      eq: (key: string, value: unknown) => { filters[key] = value; return builder; },
      is: (_key: string, _value: unknown) => builder,
      not: (_key: string, _op: string, _value: unknown) => builder,
      limit: (_count: number) => builder,
      order: (_key: string) => builder,
      insert: (values: Record<string, unknown>) => { inserted = values; return builder; },
      single: async () => result(), maybeSingle: async () => result(),
      then: <T>(resolve: (value: ReturnType<typeof result>) => T) => Promise.resolve(result()).then(resolve),
    };
    return builder;
  } };
  return { admin, versions, agent, mutations };
}
function publish(db: ReturnType<typeof database>, prompt = 'PROMPT ORIGINAL', picked = selection) {
  return publishFirstVersion(db.admin as never, org, { id: agentId, published_version_id: null }, prompt, user, picked);
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.channels.mockResolvedValue([{ id: 'channel-A' }]);
  mocks.platformKey.mockReturnValue(null);
  mocks.publish.mockResolvedValue({ ok: true });
});

describe('primeira publicação e retomada segura da reconciliação', () => {
  it('retoma a própria versão após falha de publicação sem duplicar nem ampliar grants', async () => {
    const db = database();
    const originalConfig = structuredClone(db.agent.config);
    mocks.publish.mockResolvedValueOnce({ ok: false, message: 'temporary publication failure' });
    expect(await publish(db)).toMatchObject({ published: false, reason: 'failed' });
    expect(db.versions).toHaveLength(1);
    const saved = structuredClone(db.versions[0]);
    expect(saved).toMatchObject({ system_prompt: 'PROMPT ORIGINAL', provider: 'openai', model: 'model-A',
      credential_id: 'credential-A', channel_session_id: 'channel-A', provisioning_origin: 'legacy_reconciliation',
      status: 'draft', tool_ids: [], pipeline_ids: [] });
    expect(await publish(db)).toEqual({ published: true });
    expect(db.versions).toEqual([saved]);
    expect(db.mutations).toHaveLength(1);
    expect(mocks.publish).toHaveBeenNthCalledWith(2, db.admin, { orgId: org, agentId, versionId: saved!.id, expectedProvenance: 'legacy_reconciliation' });
    expect(db.agent.config).toEqual(originalConfig);
  });

  it.each([null, 'onboarding'])('não publica versão preexistente com proveniência %s', async origin => {
    const row = { id: 'human-version', version_number: 1, provisioning_origin: origin,
      system_prompt: 'REVISÃO HUMANA', status: 'draft', tool_ids: ['grant-reviewed'] };
    const db = database([row]);
    expect(await publish(db)).toEqual({ published: false, reason: 'failed', message: 'existing_version_requires_review' });
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(db.versions).toEqual([row]);
    expect(db.mutations).toEqual([]);
  });

  it('uma versão humana adicional impede retomar automaticamente a versão própria', async () => {
    const rows = [
      { id: 'own', version_number: 1, provisioning_origin: 'legacy_reconciliation', status: 'draft' },
      { id: 'review', version_number: 2, provisioning_origin: null, status: 'draft' },
    ];
    const db = database(rows);
    expect(await publish(db)).toMatchObject({ published: false, message: 'existing_version_requires_review' });
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(db.versions).toEqual(rows);
  });

  it('confirma sucesso se a publicação foi gravada antes de uma resposta de erro', async () => {
    const db = database();
    mocks.publish.mockImplementationOnce(async () => {
      db.agent.published_version_id = 'version-own';
      return { ok: false, message: 'response interrupted after commit' };
    });
    expect(await publish(db)).toEqual({ published: true });
    expect(await publish(db)).toEqual({ published: true });
    expect(mocks.publish).toHaveBeenCalledOnce();
    expect(db.versions).toHaveLength(1);
  });
});
