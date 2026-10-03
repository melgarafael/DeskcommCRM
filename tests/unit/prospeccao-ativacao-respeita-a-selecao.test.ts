import { beforeEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * #1896 — a ativação RESPEITA a escolha do operador, medida pelo comportamento
 * de `activateCampaign`, não pela leitura do fonte.
 *
 * O teste irmão (`prospeccao-selecao-de-empresas.test.ts`) prova a decisão
 * pura e a presença da colagem por regex. Este roda a função de verdade
 * contra um cliente `pg` falso: o desmarcado vira `skipped` com o motivo, NÃO
 * cria contato, lead nem conversa — e o marcado segue o caminho de sempre.
 */

const createContact = vi.fn();
const createLead = vi.fn();
const beginService = vi.fn();
vi.mock("@/app/api/v1/contacts/_handler", () => ({
  createContactHandler: (...a: unknown[]) => createContact(...a),
}));
vi.mock("@/app/api/v1/leads/_handler", () => ({
  createLeadHandler: (...a: unknown[]) => createLead(...a),
}));
vi.mock("@/lib/atendimento/origem", () => ({
  beginServiceAtOrigin: (...a: unknown[]) => beginService(...a),
}));
vi.mock("@/lib/agent-engine/agent/router-config", () => ({
  loadActiveRouter: async () => null,
}));
vi.mock("@/lib/agent-engine/agent/agent-config", () => ({
  loadPublishedAgentConfig: async () => ({ agentId: AGENT }),
}));

const ORG = "00000000-0000-4000-8000-000000000001";
const CAMP = "00000000-0000-4000-8000-000000000002";
const AGENT = "00000000-0000-4000-8000-000000000003";
const CHANNEL = "00000000-0000-4000-8000-000000000004";
const PIPE = "00000000-0000-4000-8000-000000000005";
const STAGE_A = "00000000-0000-4000-8000-000000000006";
const STAGE_B = "00000000-0000-4000-8000-000000000007";
const config = {
  agent_id: AGENT,
  channel_session_id: CHANNEL,
  pipeline_id: PIPE,
  stage_id: STAGE_A,
  qualified_stage_id: STAGE_B,
  instruction: "Apresente o serviço com calma.",
  qualification: "Tem interesse e orçamento.",
  daily_limit: 10,
  interval_minutes: 15,
  legal_basis_ref: "legítimo interesse",
  // O caminho de sempre: contato, negócio e conversa nascem ao iniciar (#2105).
  funnel_entry: "on_start" as const,
};

const { activateCampaign } = await import("@/lib/prospecting/store");
const { RAZAO_NAO_SELECIONADA } = await import("@/lib/prospecting/schema");

type Linha = Record<string, unknown>;
function fakePool(candidatos: Linha[]) {
  const updates: { sql: string; params: unknown[] }[] = [];
  const responder = (sql: string): Linha[] => {
    if (sql.includes("pg_try_advisory_lock")) return [{ locked: true }];
    if (sql.includes("from ai_agents a join ai_agent_versions"))
      return [{ tool_ids: ["crm_move_lead_stage"], pipeline_ids: [PIPE] }];
    if (sql.includes("from channel_sessions")) return [{ provider: "waha", status: "WORKING" }];
    if (sql.includes("from crm_stages")) return [{ id: STAGE_A }, { id: STAGE_B }];
    if (sql.startsWith("select * from prospecting_campaigns"))
      return [{ id: CAMP, name: "C", status: "draft", search_status: "succeeded", config: null }];
    if (sql.includes("status='running'")) return [];
    if (sql.startsWith("select * from prospecting_candidates")) return candidatos;
    // telefone já é contato do CRM: o marcado para no motivo pré-existente,
    // sem precisar dos handlers de criação.
    if (sql.startsWith("select id from contacts where organization_id=$1 and phone_number"))
      return [{ id: "contato-existente" }];
    return [];
  };
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.startsWith("update prospecting_candidates")) updates.push({ sql, params });
      return { rows: responder(sql) };
    },
    release: () => {},
  };
  return { pool: { connect: async () => client } as unknown as pg.Pool, updates };
}

const candidato = (id: string, selected: boolean, phone: string | null) => ({
  id,
  campaign_id: CAMP,
  status: "new",
  selected,
  phone,
  contact_id: null,
  lead_id: null,
  data: { key: `place-${id}`, name: `Empresa ${id}` },
});

describe("activateCampaign respeita a seleção do operador (#1896)", () => {
  beforeEach(() => {
    createContact.mockReset();
    createLead.mockReset();
    beginService.mockReset();
  });

  it("o desmarcado vira 'Não abordado' com o motivo e não toca contato, lead nem conversa", async () => {
    const { pool, updates } = fakePool([candidato("a", false, "+5511999990001")]);
    await activateCampaign(pool, {} as SupabaseClient, ORG, CAMP, config);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.sql).toContain("status='skipped'");
    expect(updates[0]!.params).toEqual([ORG, "a", RAZAO_NAO_SELECIONADA]);
    expect(createContact).not.toHaveBeenCalled();
    expect(createLead).not.toHaveBeenCalled();
    expect(beginService).not.toHaveBeenCalled();
  });

  it("o marcado segue o caminho de sempre (aqui, o motivo pré-existente) e não ganha o motivo da seleção", async () => {
    const { pool, updates } = fakePool([
      candidato("b", true, null),
      candidato("c", true, "+5511999990002"),
    ]);
    await activateCampaign(pool, {} as SupabaseClient, ORG, CAMP, config);
    const motivos = updates.map((u) => u.sql + JSON.stringify(u.params));
    expect(motivos.some((m) => m.includes("Sem telefone brasileiro válido."))).toBe(true);
    expect(motivos.some((m) => m.includes("Contato já existe no CRM"))).toBe(true);
    expect(motivos.some((m) => m.includes(RAZAO_NAO_SELECIONADA))).toBe(false);
  });
});
