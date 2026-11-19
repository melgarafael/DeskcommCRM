import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { carregaRadarDeRisco } from "@/lib/leads/radar-de-risco";

vi.mock("@/lib/agenda/protecao-followup", () => ({
  protecaoAgendaSupabase: async () => new Map(),
}));

const ORG = "org-1";
const AGORA = new Date("2026-09-15T12:00:00.000Z");
const HA_36H = "2026-09-14T00:00:00.000Z";
const NO_FUTURO_1H = "2026-09-15T13:00:00.000Z";
const NO_FUTURO_2H = "2026-09-15T14:00:00.000Z";

type Linha = Record<string, unknown>;

function bancoFalso(tabelas: Record<string, Linha[]>): SupabaseClient {
  const from = (tabela: string) => {
    let linhas = [...(tabelas[tabela] ?? [])];
    const chain = {
      select: () => chain,
      eq: (col: string, val: unknown) => {
        linhas = linhas.filter((l) => l[col] === val);
        return chain;
      },
      is: (col: string, val: unknown) => {
        linhas = linhas.filter((l) => (l[col] ?? null) === val);
        return chain;
      },
      in: (col: string, vals: unknown[]) => {
        linhas = linhas.filter((l) => vals.includes(l[col]));
        return chain;
      },
      gt: (col: string, val: unknown) => {
        linhas = linhas.filter((l) => String(l[col] ?? "") > String(val));
        return chain;
      },
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

describe("o radar de risco reconhece follow-up de followup_enrollments", () => {
  it("lead parado há 36h com inscrição ativa em followup_enrollments entra em 'em_voo'", async () => {
    const db = bancoFalso({
      crm_pipelines: [{ id: "funil-ativo", organization_id: ORG, is_archived: false }],
      crm_leads: [
        {
          id: "lead-1",
          organization_id: ORG,
          status: "open",
          title: "Corretor X",
          pipeline_id: "funil-ativo",
          contact_id: "ct-1",
          owner_user_id: null,
          owner_kind: null,
          owner_agent_id: null,
          stage_id: null,
          last_activity_at: HA_36H,
          created_at: HA_36H,
        },
      ],
      contacts: [{ id: "ct-1", organization_id: ORG, name: "Corretor X", display_name: null }],
      cron_jobs: [],
      followup_enrollments: [
        {
          id: "enr-1",
          organization_id: ORG,
          contact_id: "ct-1",
          status: "active",
          next_eval_at: NO_FUTURO_1H,
        },
      ],
      conversations: [],
      demandas: [],
    });

    const radar = await carregaRadarDeRisco(db, { organizationId: ORG, now: AGORA });

    expect(radar.items).toHaveLength(1);
    expect(radar.items[0]!.id).toBe("lead-1");
    expect(radar.items[0]!.risk).toBe("em_voo");
    expect(radar.items[0]!.in_flight).toBe(true);
    expect(radar.items[0]!.next_followup_at).toBe(NO_FUTURO_1H);
    expect(radar.counts.em_voo).toBe(1);
    expect(radar.counts.em_risco).toBe(0);
  });

  it("escolhe a data mais próxima entre cron_jobs e followup_enrollments", async () => {
    const db = bancoFalso({
      crm_pipelines: [{ id: "funil-ativo", organization_id: ORG, is_archived: false }],
      crm_leads: [
        {
          id: "lead-2",
          organization_id: ORG,
          status: "open",
          title: "Cliente Y",
          pipeline_id: "funil-ativo",
          contact_id: "ct-2",
          owner_user_id: null,
          owner_kind: null,
          owner_agent_id: null,
          stage_id: null,
          last_activity_at: HA_36H,
          created_at: HA_36H,
        },
      ],
      contacts: [{ id: "ct-2", organization_id: ORG, name: "Cliente Y", display_name: null }],
      cron_jobs: [
        {
          contact_id: "ct-2",
          organization_id: ORG,
          kind: "at",
          enabled: true,
          next_run_at: NO_FUTURO_2H,
        },
      ],
      followup_enrollments: [
        {
          id: "enr-2",
          organization_id: ORG,
          contact_id: "ct-2",
          status: "active",
          next_eval_at: NO_FUTURO_1H,
        },
      ],
      conversations: [],
      demandas: [],
    });

    const radar = await carregaRadarDeRisco(db, { organizationId: ORG, now: AGORA });

    expect(radar.items[0]!.risk).toBe("em_voo");
    expect(radar.items[0]!.next_followup_at).toBe(NO_FUTURO_1H);
  });

  it("sem retorno futuro em nenhuma das duas tabelas, permanece como em_risco", async () => {
    const db = bancoFalso({
      crm_pipelines: [{ id: "funil-ativo", organization_id: ORG, is_archived: false }],
      crm_leads: [
        {
          id: "lead-3",
          organization_id: ORG,
          status: "open",
          title: "Cliente Z",
          pipeline_id: "funil-ativo",
          contact_id: "ct-3",
          owner_user_id: null,
          owner_kind: null,
          owner_agent_id: null,
          stage_id: null,
          last_activity_at: HA_36H,
          created_at: HA_36H,
        },
      ],
      contacts: [{ id: "ct-3", organization_id: ORG, name: "Cliente Z", display_name: null }],
      cron_jobs: [],
      followup_enrollments: [
        {
          id: "enr-3",
          organization_id: ORG,
          contact_id: "ct-3",
          status: "completed",
          next_eval_at: null,
        },
      ],
      conversations: [],
      demandas: [],
    });

    const radar = await carregaRadarDeRisco(db, { organizationId: ORG, now: AGORA });

    expect(radar.items[0]!.risk).toBe("em_risco");
    expect(radar.items[0]!.in_flight).toBe(false);
    expect(radar.items[0]!.next_followup_at).toBeNull();
    expect(radar.counts.em_voo).toBe(0);
    expect(radar.counts.em_risco).toBe(1);
  });

  it("cadência dormente com retorno marcado ('volte daqui a 28 dias') também entra em 'em_voo'", async () => {
    const db = bancoFalso({
      crm_pipelines: [{ id: "funil-ativo", organization_id: ORG, is_archived: false }],
      crm_leads: [
        {
          id: "lead-1",
          organization_id: ORG,
          status: "open",
          title: "Corretor X",
          pipeline_id: "funil-ativo",
          contact_id: "ct-1",
          owner_user_id: null,
          owner_kind: null,
          owner_agent_id: null,
          stage_id: null,
          last_activity_at: HA_36H,
          created_at: HA_36H,
        },
      ],
      contacts: [{ id: "ct-1", organization_id: ORG, name: "Corretor X", display_name: null }],
      cron_jobs: [],
      followup_enrollments: [
        {
          id: "enr-1",
          organization_id: ORG,
          contact_id: "ct-1",
          status: "dormente",
          next_eval_at: NO_FUTURO_1H,
        },
      ],
      conversations: [],
      demandas: [],
    });

    const radar = await carregaRadarDeRisco(db, { organizationId: ORG, now: AGORA });

    expect(radar.items).toHaveLength(1);
    expect(radar.items[0]!.id).toBe("lead-1");
    expect(radar.items[0]!.risk).toBe("em_voo");
    expect(radar.items[0]!.in_flight).toBe(true);
    expect(radar.items[0]!.next_followup_at).toBe(NO_FUTURO_1H);
    expect(radar.counts.em_voo).toBe(1);
    expect(radar.counts.em_risco).toBe(0);
  });
});
