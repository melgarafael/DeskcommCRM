import { randomUUID } from "node:crypto";
import pg from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { seedGov, GOV_ADMIN } from "./gov-helpers";
vi.mock("@/lib/audit", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/ai/runtime/agent", () => ({
  chaveDePlataforma: (provider: string) => (provider === "openai" ? "test-key-never-sent" : null),
}));
import { setupProspectingAgent } from "@/lib/prospecting/agent-setup";
import { prospectingAgentSetupSchema } from "@/lib/prospecting/agent-setup-schema";
import {
  beginAgentChat,
  finishAgentChat,
  getAgentSession,
  saveAgentSession,
} from "@/lib/prospecting/agent-session";
import { agentSessionWriteSchema } from "@/lib/prospecting/agent-session-schema";
import { agentProposalSchema } from "@/lib/prospecting/agent-chat-schema";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 5,
});
beforeAll(() => seedGov());
afterAll(() => pool.end());

// Exercise the canonical publish wrapper and SQL function against real Postgres,
// without requiring an HTTP PostgREST process or any external model/provider.
function publicationClient(failOnce = false): SupabaseClient {
  return {
    from() {
      const filters: Record<string, string> = {};
      const chain = {
        select: () => chain,
        eq(key: string, value: string) {
          filters[key] = value;
          return chain;
        },
        async maybeSingle() {
          const { rows } = await pool.query(
            "select provider,credential_id from ai_agent_versions where organization_id=$1 and agent_id=$2 and id=$3",
            [filters.organization_id, filters.agent_id, filters.id],
          );
          return { data: rows[0] ?? null, error: null };
        },
      };
      return chain;
    },
    async rpc(_name: string, args: Record<string, unknown>) {
      if (failOnce) {
        failOnce = false;
        return { data: null, error: { message: "publish_failed" } };
      }
      try {
        const { rows } = await pool.query(
          "select * from fn_publish_ai_agent_version($1,$2,$3,$4)",
          [
            args.p_org_id,
            args.p_agent_id,
            args.p_version_id,
            args.p_platform_credential_verified ?? false,
          ],
        );
        return { data: rows, error: null };
      } catch (error) {
        return { data: null, error: { message: (error as Error).message } };
      }
    },
  } as unknown as SupabaseClient;
}
async function fixture() {
  const org = randomUUID(),
    channel = randomUUID(),
    campaign = randomUUID();
  await pool.query(
    "insert into organizations(id,slug,legal_name,display_name,settings) values($1,$2,'Setup fixture','Setup fixture','{\"llm\":{\"provider\":\"openai\"}}')",
    [org, `setup-${org}`],
  );
  const pipeline = (
    await pool.query("select id from crm_pipelines where organization_id=$1 limit 1", [org])
  ).rows[0].id;
  const stages = (
    await pool.query(
      "select id from crm_stages where organization_id=$1 and pipeline_id=$2 and not is_won and not is_lost order by position limit 2",
      [org, pipeline],
    )
  ).rows;
  await pool.query(
    "insert into channel_sessions(id,organization_id,provider,waha_session_name,status,webhook_secret_encrypted) values($1,$2,'waha',$3,'WORKING',decode('00','hex'))",
    [channel, org, `setup-${channel}`],
  );
  await pool.query(
    "insert into prospecting_campaigns(id,organization_id,request_id,name,search) values($1,$2,$3,'Fixture','{}')",
    [campaign, org, randomUUID()],
  );
  const input = prospectingAgentSetupSchema.parse({
    request_id: randomUUID(),
    campaign_id: campaign,
    name: "Consultor comercial",
    tone: "cordial",
    instruction: "Oferecer diagnóstico de atendimento",
    qualification: "Necessidade confirmada e interesse expresso",
    channel_session_id: channel,
    pipeline_id: pipeline,
    stage_id: stages[0].id,
    qualified_stage_id: stages[1].id,
  });
  const context = { orgId: org, userId: GOV_ADMIN, requestId: randomUUID() };
  return { org, channel, campaign, input, context };
}

async function setupSessionFixture() {
  const f = await fixture();
  await pool.query(
    "update prospecting_campaigns set search_status='succeeded' where organization_id=$1 and id=$2",
    [f.org, f.campaign],
  );
  return f;
}

it("persists setup within its tenant, blocks stale edits and never writes the operational campaign config", async () => {
  const f = await setupSessionFixture(),
    other = await setupSessionFixture();
  const initial = await getAgentSession(pool, f.org, f.campaign);
  expect(initial).toMatchObject({ revision: 0, session: { messages: [], ready: false } });
  const next = agentSessionWriteSchema.parse({
    messages: [{ role: "user", content: "Quero atender clínicas" }],
    draft: { name: "Consultor", tone: "cordial" },
    input: "Ainda estou configurando",
  });
  const saved = await saveAgentSession(pool, f.context, f.campaign, 0, next);
  expect(saved.revision).toBe(1);
  expect(await getAgentSession(pool, f.org, f.campaign)).toEqual(saved);
  await expect(
    saveAgentSession(pool, f.context, f.campaign, 0, { ...next, input: "Resposta atrasada" }),
  ).rejects.toMatchObject({ status: 409 });
  await expect(getAgentSession(pool, other.org, f.campaign)).rejects.toMatchObject({ status: 404 });
  await expect(saveAgentSession(pool, other.context, f.campaign, 1, next)).rejects.toMatchObject({
    status: 404,
  });
  expect(
    (
      await pool.query(
        "select status,config from prospecting_campaigns where organization_id=$1 and id=$2",
        [f.org, f.campaign],
      )
    ).rows[0],
  ).toEqual({ status: "draft", config: null });
  const db = await pool.connect();
  try {
    await db.query("begin");
    await db.query("set local role authenticated");
    await expect(
      db.query("select agent_setup from prospecting_campaigns where id=$1", [f.campaign]),
    ).rejects.toMatchObject({ code: "42501" });
  } finally {
    await db.query("rollback");
    db.release();
  }
});

it("keeps the pending user turn across reload and retries it once; canceled and stale model results cannot overwrite edits", async () => {
  const f = await setupSessionFixture();
  const input = {
    campaign_id: f.campaign,
    revision: 0,
    messages: [{ role: "user" as const, content: "Quero oferecer diagnóstico" }],
    draft: {},
  };
  const pending = await beginAgentChat(pool, f.context, input);
  expect((await getAgentSession(pool, f.org, f.campaign)).session).toMatchObject({
    messages: input.messages,
    input: input.messages[0]!.content,
    ready: false,
  });
  const retry = await beginAgentChat(pool, f.context, { ...input, revision: pending.revision });
  expect(retry.session.messages).toEqual(input.messages);
  const response = {
    message: "Como considerar alguém qualificado?",
    draft: {},
    ready: false,
    choices: [],
    model_label: "Modelo do CRM",
    needs_continuity: false,
  };
  await expect(
    finishAgentChat(pool, f.context, f.campaign, pending.revision, response),
  ).rejects.toMatchObject({ status: 409 });
  const abort = new AbortController();
  abort.abort();
  await expect(
    finishAgentChat(pool, f.context, f.campaign, retry.revision, response, abort.signal),
  ).rejects.toThrow();
  expect((await getAgentSession(pool, f.org, f.campaign)).revision).toBe(retry.revision);
  const finished = await finishAgentChat(pool, f.context, f.campaign, retry.revision, response);
  expect(finished.session.messages).toEqual([
    ...input.messages,
    { role: "assistant", content: response.message },
  ]);
  expect(finished.session.input).toBe("");
});

it("recovers a prepared paused agent and its successful publication from the exact saved attempt", async () => {
  const f = await setupSessionFixture(),
    admin = publicationClient();
  const proposal = agentProposalSchema.parse({
    name: f.input.name,
    tone: f.input.tone,
    instruction: f.input.instruction,
    qualification: f.input.qualification,
    channel_session_id: f.input.channel_session_id,
    pipeline_id: f.input.pipeline_id,
    stage_id: f.input.stage_id,
    qualified_stage_id: f.input.qualified_stage_id,
  });
  const saved = await saveAgentSession(
    pool,
    f.context,
    f.campaign,
    0,
    agentSessionWriteSchema.parse({
      messages: [],
      draft: proposal,
      attempt: f.input,
      attempt_action: "prepare",
      uncertain: true,
    }),
  );
  const prepared = await setupProspectingAgent(pool, admin, f.context, f.input, {
    prepareOnly: true,
  });
  const row = (
    await pool.query(
      "select paused_at,published_version_id from ai_agents where organization_id=$1 and id=$2",
      [f.org, prepared.agent.id],
    )
  ).rows[0];
  expect(row.paused_at).not.toBeNull();
  expect(row.published_version_id).toBeNull();
  expect((await getAgentSession(pool, f.org, f.campaign)).session).toMatchObject({
    prepared,
    uncertain: false,
  });
  expect(
    (
      await pool.query(
        "select count(*)::int as n from event_log where organization_id=$1 and event_type='ai_agent.published'",
        [f.org],
      )
    ).rows[0].n,
  ).toBe(0);
  await expect(
    setupProspectingAgent(pool, admin, f.context, { ...f.input, name: "Outra proposta" }),
  ).rejects.toMatchObject({ status: 409 });
  // A retry of an unconfirmed preview must never become publication.
  await expect(setupProspectingAgent(pool, admin, f.context, f.input)).rejects.toMatchObject({
    status: 409,
  });
  const confirmed = await saveAgentSession(
    pool,
    f.context,
    f.campaign,
    saved.revision,
    agentSessionWriteSchema.parse({
      messages: [],
      draft: proposal,
      attempt: f.input,
      attempt_action: "publish",
      uncertain: true,
    }),
  );
  expect((await getAgentSession(pool, f.org, f.campaign)).session).toMatchObject({
    prepared,
    uncertain: true,
    attempt_action: "publish",
  });
  expect(await setupProspectingAgent(pool, admin, f.context, f.input)).toEqual(prepared);
  expect((await getAgentSession(pool, f.org, f.campaign)).session).toMatchObject({
    completed: prepared,
    uncertain: false,
  });
  expect((await getAgentSession(pool, f.org, f.campaign)).revision).toBe(confirmed.revision);
  const counts = (
    await pool.query(
      "select (select count(*) from messages where organization_id=$1)::int as messages,(select count(*) from prospecting_candidates where organization_id=$1)::int as candidates",
      [f.org],
    )
  ).rows[0];
  expect(counts).toEqual({ messages: 0, candidates: 0 });
});

it("publishes through the canonical function, retries the same agent and leaves campaign/contact queues untouched", async () => {
  const f = await fixture(),
    admin = publicationClient();
  const first = await setupProspectingAgent(pool, admin, f.context, f.input);
  expect(await setupProspectingAgent(pool, admin, f.context, f.input)).toEqual(first);
  const agent = (
    await pool.query(
      "select published_version_id,paused_at,operation_mode from ai_agents where organization_id=$1 and id=$2",
      [f.org, first.agent.id],
    )
  ).rows[0];
  expect(agent).toMatchObject({
    published_version_id: first.version_id,
    paused_at: null,
    operation_mode: "automatic",
  });
  const version = (
    await pool.query(
      "select pipeline_ids,tool_ids,handoff_tool_enabled from ai_agent_versions where organization_id=$1 and id=$2",
      [f.org, first.version_id],
    )
  ).rows[0];
  expect(version.pipeline_ids).toEqual([f.input.pipeline_id]);
  expect(version.tool_ids).toContain("crm_move_lead_stage");
  expect(version.handoff_tool_enabled).toBe(true);
  const campaign = (
    await pool.query(
      "select status,config from prospecting_campaigns where organization_id=$1 and id=$2",
      [f.org, f.campaign],
    )
  ).rows[0];
  expect(campaign).toEqual({ status: "draft", config: null });
  const counts = (
    await pool.query(
      "select (select count(*) from prospecting_candidates where organization_id=$1)::int as candidates,(select count(*) from messages where organization_id=$1)::int as messages,(select count(*) from ai_agents where organization_id=$1)::int as agents",
      [f.org],
    )
  ).rows[0];
  expect(counts).toEqual({ candidates: 0, messages: 0, agents: 1 });
  await expect(
    setupProspectingAgent(pool, admin, f.context, { ...f.input, request_id: randomUUID() }),
  ).rejects.toThrow("Use o agente existente");
});

it("enables router continuity only with explicit choice, preserving fallback, config and members across retry", async () => {
  const f = await fixture(),
    admin = publicationClient();
  const incumbent = await setupProspectingAgent(pool, admin, f.context, f.input);
  const router = randomUUID();
  await pool.query(
    "insert into ai_routers(id,organization_id,name,channel_session_id,fallback_agent_id,config) values($1,$2,'Fixture router',$3,$4,'{\"sticky\":false,\"fixture\":42}')",
    [router, f.org, f.channel, incumbent.agent.id],
  );
  await pool.query(
    "insert into ai_router_members(organization_id,router_id,agent_id,intent_name,intent_description) values($1,$2,$3,'existing','Existing fixture')",
    [f.org, router, incumbent.agent.id],
  );
  const second = { ...f.input, request_id: randomUUID(), name: "Second" };
  await expect(setupProspectingAgent(pool, admin, f.context, second)).rejects.toThrow(
    "Ative a continuidade",
  );
  expect(
    (await pool.query("select count(*)::int as n from ai_agents where organization_id=$1", [f.org]))
      .rows[0].n,
  ).toBe(1);
  const result = await setupProspectingAgent(pool, admin, f.context, {
    ...second,
    enable_router_continuity: true,
  });
  await setupProspectingAgent(pool, admin, f.context, {
    ...second,
    enable_router_continuity: true,
  });
  expect(
    (
      await pool.query(
        "select config,fallback_agent_id from ai_routers where organization_id=$1 and id=$2",
        [f.org, router],
      )
    ).rows[0],
  ).toEqual({ config: { sticky: true, fixture: 42 }, fallback_agent_id: incumbent.agent.id });
  const members = (
    await pool.query(
      "select agent_id from ai_router_members where organization_id=$1 and router_id=$2 order by position",
      [f.org, router],
    )
  ).rows;
  expect(members.map((m) => m.agent_id)).toEqual([incumbent.agent.id, result.agent.id]);
});

it("recovers the same paused draft after publish failure and rejects a changed request payload", async () => {
  const f = await fixture(),
    admin = publicationClient(true);
  await expect(setupProspectingAgent(pool, admin, f.context, f.input)).rejects.toMatchObject({
    status: 422,
    agentId: expect.any(String),
  });
  const draft = (
    await pool.query(
      "select id,published_version_id,paused_at from ai_agents where organization_id=$1",
      [f.org],
    )
  ).rows[0];
  expect(draft.published_version_id).toBeNull();
  expect(draft.paused_at).not.toBeNull();
  await expect(
    setupProspectingAgent(pool, admin, f.context, { ...f.input, name: "Changed" }),
  ).rejects.toMatchObject({ status: 409 });
  const result = await setupProspectingAgent(pool, admin, f.context, f.input);
  expect(result.agent.id).toBe(draft.id);
  expect(
    (await pool.query("select count(*)::int as n from ai_agents where organization_id=$1", [f.org]))
      .rows[0].n,
  ).toBe(1);
});

it("rejects a campaign or funnel from another tenant before any agent creation", async () => {
  const a = await fixture(),
    b = await fixture(),
    admin = publicationClient();
  await expect(
    setupProspectingAgent(pool, admin, a.context, { ...a.input, campaign_id: b.campaign }),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    setupProspectingAgent(pool, admin, a.context, {
      ...a.input,
      pipeline_id: b.input.pipeline_id,
      stage_id: b.input.stage_id,
      qualified_stage_id: b.input.qualified_stage_id,
    }),
  ).rejects.toMatchObject({ status: 422 });
  expect(
    (await pool.query("select count(*)::int as n from ai_agents where organization_id=$1", [a.org]))
      .rows[0].n,
  ).toBe(0);
});

it("serializes two different requests for an empty channel across publication without stranding a second agent", async () => {
  const f = await fixture();
  const client = publicationClient();
  const originalRpc = client.rpc.bind(client);
  // Leave enough time at the exact inter-transaction boundary for the second
  // request to run. Without the channel session lock it creates another draft.
  client.rpc = (async (...args: Parameters<typeof client.rpc>) => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    return originalRpc(...args);
  }) as unknown as typeof client.rpc;
  const results = await Promise.allSettled([
    setupProspectingAgent(pool, client, f.context, f.input),
    setupProspectingAgent(pool, client, f.context, { ...f.input, request_id: randomUUID() }),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const agents = (
    await pool.query(
      "select published_version_id,paused_at from ai_agents where organization_id=$1",
      [f.org],
    )
  ).rows;
  expect(agents).toHaveLength(1);
  expect(agents[0].published_version_id).not.toBeNull();
  expect(agents[0].paused_at).toBeNull();
});
