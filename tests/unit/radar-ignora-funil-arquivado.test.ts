import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { carregaRadarDeRisco } from "@/lib/leads/radar-de-risco";

/** O mesmo teto que o módulo usa: a janela que o corte de funil tem de caber. */
const SCAN_CAP = 500;

/**
 * Funil arquivado continuava no Radar de risco (issue #940): arquivar só marca
 * `crm_pipelines.is_archived`, os leads seguem `open`, e o radar lia todo lead
 * aberto da organização. A mesma função serve a tela (`/api/v1/leads/at-risk`)
 * e a ferramenta da IA (`lib/mcp/tools/retencao.ts`).
 *
 * O banco falso APLICA os filtros (`eq`, `is`, `in`, `not in`) E o `limit`: um
 * dublê que os ignorasse passaria com ou sem o conserto. O `limit` honrado é o
 * que permite provar ONDE o corte mora — ver o terceiro caso.
 */

vi.mock("@/lib/agenda/protecao-followup", () => ({
  protecaoAgendaSupabase: async () => new Map(),
}));

const ORG = "org-1";
const AGORA = new Date("2026-09-15T12:00:00.000Z");
const HA_MUITO = "2026-08-01T12:00:00.000Z";

type Linha = Record<string, unknown>;

/** Uma chamada `.in(coluna, [...])`, para o caso que mede o TAMANHO do lote. */
interface ChamadaIn {
  tabela: string;
  coluna: string;
  quantos: number;
}

function bancoFalso(tabelas: Record<string, Linha[]>, registro: ChamadaIn[] = []): SupabaseClient {
  const from = (tabela: string) => {
    let linhas = [...(tabelas[tabela] ?? [])];
    const chain = {
      select: () => chain,
      eq: (col: string, val: unknown) => ((linhas = linhas.filter((l) => l[col] === val)), chain),
      is: (col: string, val: unknown) => ((linhas = linhas.filter((l) => (l[col] ?? null) === val)), chain),
      in: (col: string, vals: unknown[]) => {
        registro.push({ tabela, coluna: col, quantos: vals.length });
        linhas = linhas.filter((l) => vals.includes(l[col]));
        return chain;
      },
      not: (col: string, op: string, lista: string) => {
        if (op !== "in") throw new Error(`operador não suportado no dublê: ${op}`);
        const vals = lista.replace(/^\(|\)$/g, "").split(",");
        linhas = linhas.filter((l) => !vals.includes(String(l[col])));
        return chain;
      },
      order: () => chain,
      // HONRA o teto. Sem isto, "cortar na consulta" e "cortar em JS depois do
      // `.limit()`" produzem a MESMA saída no dublê, e o teste não distingue as
      // duas — que é a diferença que o comentário do módulo afirma existir.
      limit: (n: number) => ((linhas = linhas.slice(0, n)), chain),
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

  it("o corte dos leads mora na CONSULTA: arquivado não ocupa vaga na janela de 500", async () => {
    // O LUGAR do corte, não o resultado dele. Os dois casos acima ficam verdes
    // com o filtro em JS DEPOIS do `.limit(SCAN_CAP)` — e aí o comportamento
    // muda para quem tem volume: 500 leads de funil arquivado enchem a janela e
    // o único lead ativo nunca é lido. É exatamente o que
    // `lib/leads/radar-de-risco.ts` afirma no comentário do corte, e até aqui
    // nada media.
    const arquivadosEmMassa = Array.from({ length: SCAN_CAP }, (_, i) => ({
      id: `arq-${i}`, organization_id: ORG, status: "open", title: `Arquivado ${i}`,
      pipeline_id: "funil-arquivado", contact_id: null, owner_user_id: null, owner_kind: null,
      owner_agent_id: null, stage_id: null, last_activity_at: HA_MUITO, created_at: HA_MUITO,
    }));
    const db = bancoFalso({
      crm_pipelines: [
        { id: "funil-ativo", organization_id: ORG, is_archived: false },
        { id: "funil-arquivado", organization_id: ORG, is_archived: true },
      ],
      // O ativo vem DEPOIS dos 500 arquivados: na janela de `SCAN_CAP` ele é o
      // primeiro a cair se o corte não tiver acontecido antes.
      crm_leads: [
        ...arquivadosEmMassa,
        {
          id: "lead-ativo", organization_id: ORG, status: "open", title: "Ativo",
          pipeline_id: "funil-ativo", contact_id: null, owner_user_id: null, owner_kind: null,
          owner_agent_id: null, stage_id: null, last_activity_at: HA_MUITO, created_at: HA_MUITO,
        },
      ],
      demandas: [],
    });
    const radar = await carregaRadarDeRisco(db, { organizationId: ORG, now: AGORA });
    expect(radar.items.map((l) => l.id)).toContain("lead-ativo");
  });

  it("a lista de ids das demandas viaja em lotes, não numa URL só", async () => {
    // A consulta que resolve o funil das demandas recebia até `SCAN_CAP` uuids
    // de uma vez, e eles vão na QUERYSTRING do PostgREST (~37 bytes cada,
    // ~18 KB no teto). Quem corta uma linha de request longa devolve 414/400, e
    // o radar inteiro viraria 500 para a organização com mais demandas abertas.
    const quantas = 250;
    const leadsArquivados = Array.from({ length: quantas }, (_, i) => ({
      id: `arq-${i}`, organization_id: ORG, status: "open", title: `Arquivado ${i}`,
      pipeline_id: "funil-arquivado", contact_id: null, owner_user_id: null, owner_kind: null,
      owner_agent_id: null, stage_id: null, last_activity_at: HA_MUITO, created_at: HA_MUITO,
    }));
    const registro: ChamadaIn[] = [];
    const db = bancoFalso(
      {
        crm_pipelines: [
          { id: "funil-ativo", organization_id: ORG, is_archived: false },
          { id: "funil-arquivado", organization_id: ORG, is_archived: true },
        ],
        crm_leads: [
          ...leadsArquivados,
          {
            id: "lead-ativo", organization_id: ORG, status: "open", title: "Ativo",
            pipeline_id: "funil-ativo", contact_id: null, owner_user_id: null, owner_kind: null,
            owner_agent_id: null, stage_id: null, last_activity_at: HA_MUITO, created_at: HA_MUITO,
          },
        ],
        demandas: [
          ...leadsArquivados.map((l, i) => ({
            id: `d-arq-${i}`, organization_id: ORG, lead_id: l.id, contact_id: null,
            aberta_em: HA_MUITO, origem: "x", fechada_em: null, proximo_passo: null,
          })),
          { id: "demanda-ativa", organization_id: ORG, lead_id: "lead-ativo", contact_id: null, aberta_em: HA_MUITO, origem: "x", fechada_em: null, proximo_passo: null },
        ],
      },
      registro,
    );
    const radar = await carregaRadarDeRisco(db, { organizationId: ORG, now: AGORA });

    // O resultado continua certo — o lote não pode custar correção.
    expect(radar.sem_proximo_passo.map((d) => d.id)).toEqual(["demanda-ativa"]);

    const porLote = registro.filter((c) => c.tabela === "crm_leads" && c.coluna === "id");
    // Controle positivo: se a instrumentação não viu chamada nenhuma, o
    // `toBeLessThanOrEqual` abaixo passaria sobre lista vazia — verde por cegueira.
    expect(porLote.length).toBeGreaterThan(1);
    // `quantas + 1`: a demanda ATIVA também carrega um `lead_id`, e ele entra na
    // mesma lista — o corte só descobre de que funil o lead é depois de perguntar.
    expect(porLote.reduce((soma, c) => soma + c.quantos, 0)).toBe(quantas + 1);
    for (const c of porLote) expect(c.quantos).toBeLessThanOrEqual(100);
  });
});
