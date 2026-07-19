import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/ai/agents/publish", () => ({ publishAgentVersion: vi.fn() }));

import type { SupabaseClient } from "@supabase/supabase-js";

import { publishAgentVersion } from "@/lib/ai/agents/publish";
import { applyProposal, composeAppliedPrompt } from "./apply-proposal";

const ORG = "11111111-0000-4000-8000-000000000001";
const AGENT = "22222222-0000-4000-8000-000000000002";
const PROPOSAL = "33333333-0000-4000-8000-000000000003";
const USER = "44444444-0000-4000-8000-000000000004";
const PUB_VERSION = "55555555-0000-4000-8000-000000000005";
const NEW_VERSION = "66666666-0000-4000-8000-000000000006";

/**
 * Stub encadeável mínimo do PostgREST: cada `from(tabela)` consome a próxima
 * resposta programada daquela tabela (FIFO) — o teste declara o cenário como
 * dados, o código real percorre a cadeia .select().eq()...
 */
function stubAdmin(script: Record<string, unknown[]>): SupabaseClient {
  const queues = new Map(Object.entries(script).map(([k, v]) => [k, [...v]]));
  const from = (table: string) => {
    const value = queues.get(table)?.shift() ?? null;
    const result = { data: value, error: null };
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    for (const m of ["select", "eq", "is", "not", "order", "limit", "insert", "update"]) {
      chain[m] = vi.fn(self);
    }
    chain["maybeSingle"] = vi.fn(async () => result);
    chain["single"] = vi.fn(async () =>
      value === null ? { data: null, error: { message: "no row" } } : result,
    );
    // update().eq()... sem single: resolve como promise (marcação da proposta)
    chain["then"] = (resolve: (v: unknown) => unknown) => resolve({ data: value, error: null });
    return chain;
  };
  return { from } as unknown as SupabaseClient;
}

const BASE_VERSION = {
  id: PUB_VERSION,
  version_number: 3,
  system_prompt: "Você é o assistente da loja.",
  provider: "anthropic",
  model: "claude-haiku-4-5",
  credential_id: "77777777-0000-4000-8000-000000000007",
  tool_ids: ["crm_list_leads"],
  trigger_config: null,
  channel_session_id: "88888888-0000-4000-8000-000000000008",
  max_steps: 8,
  token_budget: null,
  cost_budget_cents: null,
  history_message_window: 30,
  history_token_window: null,
  handoff_keywords: [],
  handoff_tool_enabled: true,
};

describe("composeAppliedPrompt — bullet vira seção aditiva, diff auditável", () => {
  it("apende seção no fim, sem reescrever o prompt base", () => {
    const out = composeAppliedPrompt("PROMPT BASE\n", "  responda o preço junto do prazo  ");
    expect(out).toBe(
      "PROMPT BASE\n\n## Aprendizado do flywheel\n- responda o preço junto do prazo\n",
    );
    expect(out.startsWith("PROMPT BASE")).toBe(true);
  });
});

describe("applyProposal — guards e fluxo publish-por-ponteiro", () => {
  it("proposta inexistente → proposal_not_found", async () => {
    const admin = stubAdmin({ flywheel_distiller_proposals: [null] });
    const r = await applyProposal(admin, { orgId: ORG, agentId: AGENT, proposalId: PROPOSAL, userId: USER });
    expect(r).toMatchObject({ ok: false, code: "proposal_not_found" });
  });

  it("já aplicada → proposal_already_applied (idempotência do clique)", async () => {
    const admin = stubAdmin({
      flywheel_distiller_proposals: [
        { id: PROPOSAL, type: "playbook_bullet", content: "x", applied_at: "2026-07-20T00:00:00Z" },
      ],
    });
    const r = await applyProposal(admin, { orgId: ORG, agentId: AGENT, proposalId: PROPOSAL, userId: USER });
    expect(r).toMatchObject({ ok: false, code: "proposal_already_applied" });
  });

  it("tipo não-playbook → proposal_type_unsupported", async () => {
    const admin = stubAdmin({
      flywheel_distiller_proposals: [
        { id: PROPOSAL, type: "golden_case", content: "x", applied_at: null },
      ],
    });
    const r = await applyProposal(admin, { orgId: ORG, agentId: AGENT, proposalId: PROPOSAL, userId: USER });
    expect(r).toMatchObject({ ok: false, code: "proposal_type_unsupported" });
  });

  it("agente sem versão publicada → agent_not_published", async () => {
    const admin = stubAdmin({
      flywheel_distiller_proposals: [
        { id: PROPOSAL, type: "playbook_bullet", content: "x", applied_at: null },
      ],
      ai_agents: [{ id: AGENT, published_version_id: null }],
    });
    const r = await applyProposal(admin, { orgId: ORG, agentId: AGENT, proposalId: PROPOSAL, userId: USER });
    expect(r).toMatchObject({ ok: false, code: "agent_not_published" });
  });

  it("caminho feliz: cria versão N+1 com bullet apendado e flipa o ponteiro", async () => {
    vi.mocked(publishAgentVersion).mockResolvedValueOnce({
      ok: true,
      agent_id: AGENT,
      version_id: NEW_VERSION,
      previous_version_id: PUB_VERSION,
      published_at: "2026-07-20T12:00:00Z",
    });
    const admin = stubAdmin({
      flywheel_distiller_proposals: [
        { id: PROPOSAL, type: "playbook_bullet", content: "sempre confirme o CEP", applied_at: null },
        {}, // update de marcação applied_*
      ],
      ai_agents: [{ id: AGENT, published_version_id: PUB_VERSION }],
      ai_agent_versions: [
        BASE_VERSION, // select da base publicada
        { version_number: 3 }, // max version_number
        { id: NEW_VERSION, version_number: 4 }, // insert retornando
      ],
    });
    const r = await applyProposal(admin, { orgId: ORG, agentId: AGENT, proposalId: PROPOSAL, userId: USER });
    expect(r).toEqual({ ok: true, versionId: NEW_VERSION, versionNumber: 4 });
    expect(publishAgentVersion).toHaveBeenCalledWith(admin, {
      orgId: ORG,
      agentId: AGENT,
      versionId: NEW_VERSION,
    });
  });

  it("publish vetado (ex.: sessão offline) → publish_failed e proposta segue pendente", async () => {
    vi.mocked(publishAgentVersion).mockResolvedValueOnce({
      ok: false,
      code: "channel_session_offline",
      message: "channel_session_offline",
    });
    const admin = stubAdmin({
      flywheel_distiller_proposals: [
        { id: PROPOSAL, type: "playbook_bullet", content: "y", applied_at: null },
      ],
      ai_agents: [{ id: AGENT, published_version_id: PUB_VERSION }],
      ai_agent_versions: [BASE_VERSION, { version_number: 3 }, { id: NEW_VERSION, version_number: 4 }],
    });
    const r = await applyProposal(admin, { orgId: ORG, agentId: AGENT, proposalId: PROPOSAL, userId: USER });
    expect(r).toMatchObject({ ok: false, code: "publish_failed" });
    expect((r as { message: string }).message).toContain("channel_session_offline");
  });
});
