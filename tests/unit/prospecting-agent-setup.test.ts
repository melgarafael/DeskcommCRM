import { beforeEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
const mocks = vi.hoisted(() => ({
  publish: vi.fn(),
  create: vi.fn(),
  audit: vi.fn(),
  platform: vi.fn(),
}));
vi.mock("@/lib/ai/agents/publish", () => ({ publishAgentVersion: mocks.publish }));
vi.mock("@/lib/ai/agents/create-draft", () => ({ createMcpAgentDraft: mocks.create }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/ai/runtime/agent", () => ({ chaveDePlataforma: mocks.platform }));
vi.mock("@/lib/ai/agents/capacidades-padrao", () => ({
  capacidadesPadraoDoOnboarding: () => [
    "crm_get_lead",
    "crm_list_leads",
    "crm_list_pipelines",
    "crm_update_lead",
    "crm_move_lead_stage",
    "crm_create_lead",
  ],
}));
import {
  setupProspectingAgent,
  setupAgentId,
  resolveSetupModel,
  prospectingAgentPrompt,
} from "@/lib/prospecting/agent-setup";
import { prospectingAgentSetupSchema } from "@/lib/prospecting/agent-setup-schema";
import { writeRouterMembers } from "@/lib/ai/agents/router-members";

const org = "10000000-0000-4000-8000-000000000001";
const channel = "10000000-0000-4000-8000-000000000002";
const input = prospectingAgentSetupSchema.parse({
  request_id: org,
  campaign_id: org,
  name: "Consultor comercial",
  tone: "cordial",
  instruction: "Oferecer diagnóstico de atendimento comercial",
  qualification: "Necessidade confirmada e interesse em conversar",
  channel_session_id: channel,
  pipeline_id: org,
  stage_id: org,
  qualified_stage_id: channel,
});
const context = { orgId: org, userId: org, requestId: org };
type AgentFixture = {
  id: string;
  name: string;
  config: { prospecting_setup: Record<string, unknown> };
  paused_at: Date | string | null;
  published_version_id: string | null;
  archived_at: string | null;
};
type State = {
  agent: AgentFixture | null;
  version: Record<string, unknown> | null;
  router: {
    id: string;
    is_active: boolean;
    channel_session_id: string;
    config: Record<string, unknown>;
  } | null;
  campaign: boolean;
  incumbent: boolean;
  failAppend: boolean;
  members: string[];
};
function database() {
  const state: State = {
    agent: null,
    version: null,
    router: {
      id: org,
      is_active: true,
      channel_session_id: channel,
      config: { sticky: true, classifier_model: "unchanged" },
    },
    campaign: true,
    incumbent: false,
    failAppend: false,
    members: ["existing-agent"],
  };
  let snapshot: string | null = null;
  const db = {
    release: vi.fn(),
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql === "begin") snapshot = JSON.stringify(state);
      if (sql === "rollback" && snapshot) {
        Object.assign(state, JSON.parse(snapshot));
        snapshot = null;
      }
      if (sql === "commit") snapshot = null;
      if (sql.startsWith("select id,name,config,published_version_id"))
        return { rows: state.agent ? [state.agent] : [] };
      if (sql.startsWith("select id from prospecting_campaigns"))
        return { rows: state.campaign && params[0] === org ? [{ id: org }] : [] };
      if (sql.startsWith("select id,provider,status from channel_sessions"))
        return { rows: [{ id: channel, provider: "waha", status: "WORKING" }] };
      if (sql.startsWith("select s.id from crm_stages"))
        return { rows: [{ id: org }, { id: channel }] };
      if (sql.startsWith("select id from ai_routers"))
        return { rows: state.router ? [{ id: org }] : [] };
      if (sql.startsWith("select id,config,is_active"))
        return { rows: state.router ? [state.router] : [] };
      if (sql.startsWith("select a.id from ai_agents"))
        return { rows: state.incumbent ? [{ id: "incumbent" }] : [] };
      if (sql.startsWith("select v.provider"))
        return {
          rows: [
            {
              provider: "openai",
              model: "model-tools",
              credential_id: null,
              display_name: "Modelo configurado",
            },
          ],
        };
      if (sql.startsWith("select published_version_id"))
        return { rows: [{ published_version_id: state.agent?.published_version_id ?? null }] };
      if (sql.startsWith("select * from ai_agent_versions"))
        return { rows: state.version ? [state.version] : [] };
      if (sql.startsWith("select id from ai_agents"))
        return { rows: state.agent ? [{ id: state.agent.id }] : [] };
      if (sql.startsWith("select id from ai_router_members"))
        return { rows: state.members.includes(params[2] as string) ? [{ id: org }] : [] };
      if (sql.startsWith("insert into ai_router_members")) {
        if (state.failAppend) throw new Error("db_unavailable");
        state.members.push(params[2] as string);
      }
      if (sql.startsWith("update ai_routers")) state.router!.config.sticky = true;
      if (sql.startsWith("update ai_agents set config=jsonb_set"))
        state.agent!.config.prospecting_setup = JSON.parse(params[2] as string);
      if (sql.startsWith("update ai_agents set paused_at")) {
        state.agent!.paused_at = null;
        state.agent!.config.prospecting_setup.state = "ready";
        return { rows: [{ id: state.agent!.id }] };
      }
      return { rows: [] };
    }),
  };
  mocks.create.mockImplementation(async (_db, _context, payload, options) => {
    state.agent = {
      id: options.agentId,
      name: payload.name,
      config: structuredClone(options.config),
      paused_at: options.pausedAt,
      published_version_id: null,
      archived_at: null,
    };
    state.version = { ...payload.version, id: options.versionId };
    return { agent: state.agent, version: state.version };
  });
  mocks.publish.mockImplementation(async () => {
    state.agent!.published_version_id = state.version!.id as string;
    return { ok: true };
  });
  return { state, db, pool: { connect: async () => db } as unknown as pg.Pool };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.platform.mockReturnValue("configured");
  mocks.audit.mockResolvedValue(undefined);
});
const admin = {} as SupabaseClient;

describe("inline prospecting agent setup", () => {
  it("prepares a paused draft without publication or continuity changes, then publishes that exact draft after explicit choice", async () => {
    const { state, pool } = database();
    state.router!.config.sticky = false;
    const prepared = await setupProspectingAgent(pool, admin, context, input, {
      prepareOnly: true,
    });
    expect(await setupProspectingAgent(pool, admin, context, input, { prepareOnly: true })).toEqual(
      prepared,
    );
    expect(state.agent!.paused_at).not.toBeNull();
    expect(state.agent!.published_version_id).toBeNull();
    expect(state.router!.config.sticky).toBe(false);
    expect(state.members).toEqual(["existing-agent"]);
    expect(mocks.publish).not.toHaveBeenCalled();
    await expect(setupProspectingAgent(pool, admin, context, input)).rejects.toThrow(
      "Ative a continuidade",
    );
    const published = await setupProspectingAgent(pool, admin, context, {
      ...input,
      enable_router_continuity: true,
    });
    expect(published).toEqual(prepared);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.publish).toHaveBeenCalledTimes(1);
    expect(state.agent!.paused_at).toBeNull();
    expect(state.router!.config.sticky).toBe(true);
  });
  it("refuses an edited proposal or draft under an already prepared attempt", async () => {
    const { state, pool } = database();
    await setupProspectingAgent(pool, admin, context, input, { prepareOnly: true });
    await expect(
      setupProspectingAgent(
        pool,
        admin,
        context,
        { ...input, name: "Outro agente" },
        { prepareOnly: true },
      ),
    ).rejects.toMatchObject({ status: 409 });
    state.version!.system_prompt = "Edição externa depois do teste";
    await expect(setupProspectingAgent(pool, admin, context, input)).rejects.toMatchObject({
      status: 409,
    });
    expect(mocks.publish).not.toHaveBeenCalled();
  });
  it("prepares a published agent with scoped tools, preserving router members and never starting campaign", async () => {
    const { state, db, pool } = database();
    const result = await setupProspectingAgent(pool, admin, context, input);
    expect(result.agent.id).toBe(setupAgentId(org, org, org));
    expect(state.members).toEqual(["existing-agent", result.agent.id]);
    expect(state.router!.config.classifier_model).toBe("unchanged");
    expect(state.version!.pipeline_ids).toEqual([org]);
    expect(state.version!.tool_ids).toContain("crm_move_lead_stage");
    expect(state.version!.tool_ids).not.toContain("crm_create_lead");
    expect(state.version!.handoff_tool_enabled).toBe(true);
    expect(state.agent!.paused_at).toBeNull();
    expect(
      db.query.mock.calls.some(([sql]) =>
        /update prospecting_campaigns|insert into messages/.test(sql),
      ),
    ).toBe(false);
    expect(db.release).toHaveBeenCalledTimes(1);
  });
  it("replays a lost response without creating, publishing or appending twice", async () => {
    const { state, pool } = database();
    const first = await setupProspectingAgent(pool, admin, context, input);
    expect(await setupProspectingAgent(pool, admin, context, input)).toEqual(first);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.publish).toHaveBeenCalledTimes(1);
    expect(state.members).toHaveLength(2);
  });
  it("rejects a changed payload under the same request id without altering existing agent", async () => {
    const { state, pool } = database();
    await setupProspectingAgent(pool, admin, context, input);
    await expect(
      setupProspectingAgent(pool, admin, context, { ...input, name: "Different" }),
    ).rejects.toMatchObject({ status: 409 });
    expect(state.agent!.name).toBe(input.name);
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });
  it("does not create for a foreign or absent campaign", async () => {
    const { pool } = database();
    await expect(
      setupProspectingAgent(pool, admin, { ...context, orgId: channel }, input),
    ).rejects.toMatchObject({ status: 404 });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(setupAgentId(org, org, org)).not.toBe(setupAgentId(channel, org, org));
  });
  it("refuses a non-sticky router before writes unless continuity was explicitly chosen", async () => {
    const { state, pool } = database();
    state.router!.config.sticky = false;
    await expect(setupProspectingAgent(pool, admin, context, input)).rejects.toMatchObject({
      status: 422,
    });
    expect(mocks.create).not.toHaveBeenCalled();
    await setupProspectingAgent(pool, admin, context, { ...input, enable_router_continuity: true });
    expect(state.router!.config).toEqual({ sticky: true, classifier_model: "unchanged" });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ai.router_updated" }),
    );
  });
  it("does not displace an occupied channel without a router", async () => {
    const { state, pool } = database();
    state.router = null;
    state.incumbent = true;
    await expect(setupProspectingAgent(pool, admin, context, input)).rejects.toThrow(
      "Use o agente existente",
    );
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("allows a channel without a router when it has no incumbent", async () => {
    const { state, pool } = database();
    state.router = null;
    await setupProspectingAgent(pool, admin, context, input);
    expect(state.agent!.paused_at).toBeNull();
    expect(state.members).toEqual(["existing-agent"]);
  });
  it("retains a paused draft on publication failure and resumes the same agent", async () => {
    const { state, pool } = database();
    mocks.publish.mockResolvedValueOnce({ ok: false });
    await expect(setupProspectingAgent(pool, admin, context, input)).rejects.toMatchObject({
      agentId: setupAgentId(org, org, org),
    });
    expect(state.agent!.paused_at).not.toBeNull();
    expect(state.members).toEqual(["existing-agent"]);
    await setupProspectingAgent(pool, admin, context, input);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(state.agent!.paused_at).toBeNull();
  });
  it("rolls back router changes when append fails and retries publication without a duplicate", async () => {
    const { state, pool } = database();
    state.router!.config.sticky = false;
    state.failAppend = true;
    const request = { ...input, enable_router_continuity: true };
    await expect(setupProspectingAgent(pool, admin, context, request)).rejects.toMatchObject({
      agentId: setupAgentId(org, org, org),
    });
    expect(state.router!.config.sticky).toBe(false);
    expect(state.agent!.paused_at).not.toBeNull();
    state.failAppend = false;
    await setupProspectingAgent(pool, admin, context, request);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.publish).toHaveBeenCalledTimes(1);
  });
  it("does not publish a recovered draft changed in the editor", async () => {
    const { state, pool } = database();
    mocks.publish.mockResolvedValueOnce({ ok: false });
    await expect(setupProspectingAgent(pool, admin, context, input)).rejects.toThrow();
    state.version!.system_prompt = "Uma alteração manual no editor do agente";
    await expect(setupProspectingAgent(pool, admin, context, input)).rejects.toMatchObject({
      status: 409,
    });
    expect(mocks.publish).toHaveBeenCalledTimes(1);
  });
  it("keeps transparent commercial instructions and observed qualification criteria", () => {
    const prompt = prospectingAgentPrompt(input);
    expect(prompt).toContain(input.instruction);
    expect(prompt).toContain(input.qualification);
    expect(prompt).toContain("não significam qualificação");
    expect(prompt).toContain("nunca alegue cadastro");
  });
});

describe("model and router prerequisites", () => {
  it("fails closed when there is no usable credential or platform key", async () => {
    mocks.platform.mockReturnValue(null);
    const db = { query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as pg.PoolClient;
    await expect(resolveSetupModel(db, org)).rejects.toThrow("Configure uma chave");
  });
  it("validates all replacement agents before deleting existing router members", async () => {
    const db = {
      query: vi.fn(async (sql: string) => ({
        rows: sql.includes("from ai_routers") ? [{ id: org }] : [],
      })),
    } as unknown as pg.PoolClient;
    await expect(
      writeRouterMembers(
        db,
        org,
        org,
        [{ agent_id: channel, intent_name: "vendas", intent_description: "Vendas", examples: [] }],
        "replace",
      ),
    ).rejects.toThrow("member_agent_not_found");
    expect(vi.mocked(db.query).mock.calls.some(([sql]) => String(sql).startsWith("delete"))).toBe(
      false,
    );
  });
});
