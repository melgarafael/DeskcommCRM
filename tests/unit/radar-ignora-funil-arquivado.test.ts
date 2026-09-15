import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { carregaRadarDeRisco } from "@/lib/leads/radar-de-risco";

/**
 * Funil arquivado continuava no Radar de risco (issue #940): arquivar só marca
 * `crm_pipelines.is_archived`, os leads seguem `open`, e o radar lia todo lead
 * aberto da organização. A mesma função serve a tela (`/api/v1/leads/at-risk`)
 * e a ferramenta da IA (`lib/mcp/tools/retencao.ts`).
 *
 * O banco falso APLICA os filtros (`eq`, `is`, `in`, `not in`): um dublê que os
 * ignorasse passaria com ou sem o conserto.
 */

vi.mock("@/lib/agenda/protecao-followup", () => ({
  protecaoAgendaSupabase: async () => new Map(),
}));

const ORG = "org-1";
const AGORA = new Date("2026-09-15T12:00:00.000Z");
const HA_MUITO = "2026-08-01T12:00:00.000Z";

type Linha = Record<string, unknown>;

function bancoFalso(tabelas: Record<string, Linha[]>): SupabaseClient {
  const from = (tabela: string) => {
    let linhas = [...(tabelas[tabela] ?? [])];
    const chain = {
      select: () => chain,
      eq: (col: string, val: unknown) => ((linhas = linhas.filter((l) => l[col] === val)), chain),
      is: (col: string, val: unknown) => ((linhas = linhas.filter((l) => (l[col] ?? null) === val)), chain),
      in: (col: string, vals: unknown[]) => ((linhas = linhas.filter((l) => vals.includes(l[col]))), chain),
      not: (col: string, op: string, lista: string) => {
        if (op !== "in") throw new Error(`operador não suportado no dublê: ${op}`);
        const vals = lista.replace(/^\(|\)$/g, "").split(",");
        linhas = linhas.filter((l) => !vals.includes(String(l[col])));
        return chain;
      },
      order: () => chain,
      limit: () => chain,
      maybeSingle: async () => ({ data: linhas[0] ?? null, error: null }),
      then: (res: (v: unknown) => unknown) => Promise.resolve({ data: linhas, error: null }).then(res),
    };
    return chain;
  };
  return { from } as unknown as SupabaseClient;
}

function banco() {
  return bancoFalso({
    crm_pipelines: [
      { id: "funil-ativo", organization_id: ORG, is_archived: false },
      { id: "funil-arquivado", organization_id: ORG, is_archived: true },
    ],
    crm_leads: [
      {
        id: "lead-ativo", organization_id: ORG, status: "open", title: "Ativo", pipeline_id: "funil-ativo",
        contact_id: null, owner_user_id: null, owner_kind: null, owner_agent_id: null, stage_id: null,
        last_activity_at: HA_MUITO, created_at: HA_MUITO,
      },
      {
        id: "lead-arquivado", organization_id: ORG, status: "open", title: "Arquivado", pipeline_id: "funil-arquivado",
        contact_id: null, owner_user_id: null, owner_kind: null, owner_agent_id: null, stage_id: null,
        last_activity_at: HA_MUITO, created_at: HA_MUITO,
      },
    ],
    demandas: [
      { id: "demanda-ativa", organization_id: ORG, lead_id: "lead-ativo", contact_id: "c-1", aberta_em: HA_MUITO, origem: "x", fechada_em: null, proximo_passo: null },
      { id: "demanda-arquivada", organization_id: ORG, lead_id: "lead-arquivado", contact_id: "c-2", aberta_em: HA_MUITO, origem: "x", fechada_em: null, proximo_passo: null },
    ],
  });
}

describe("radar de risco e funil arquivado", () => {
  it("lead de funil arquivado não aparece no radar", async () => {
    const radar = await carregaRadarDeRisco(banco(), { organizationId: ORG, now: AGORA });
    expect(radar.items.map((l) => l.id)).toEqual(["lead-ativo"]);
  });

  it("demanda ligada a lead de funil arquivado não aparece em 'sem próximo passo'", async () => {
    const radar = await carregaRadarDeRisco(banco(), { organizationId: ORG, now: AGORA });
    expect(radar.sem_proximo_passo.map((d) => d.id)).toEqual(["demanda-ativa"]);
  });
});
