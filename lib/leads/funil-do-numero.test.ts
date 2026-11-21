import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { funilDoNumero } from "./nascimento-do-lead";

const ORG = "11111111-1111-4111-8111-111111111111";
const NUMERO = "22222222-2222-4222-8222-222222222222";
const FUNIL = "33333333-3333-4333-8333-333333333333";
const ETAPA = "44444444-4444-4444-8444-444444444444";
const PRIMEIRA = "55555555-5555-4555-8555-555555555555";

type Filtros = Record<string, unknown>;
type Resposta = (tabela: string, filtros: Filtros) => unknown;

/** Um Supabase de mentira: cada `maybeSingle` responde pela tabela e pelos filtros pedidos. */
function banco(responde: Resposta) {
  const consultas: Array<{ tabela: string; filtros: Filtros }> = [];
  return {
    consultas,
    db: {
      from(tabela: string) {
        const filtros: Filtros = {};
        const b: Record<string, unknown> = {
          select: () => b,
          eq: (c: string, v: unknown) => ((filtros[c] = v), b),
          order: () => b,
          limit: () => b,
          maybeSingle: async () => {
            consultas.push({ tabela, filtros: { ...filtros } });
            return { data: responde(tabela, filtros), error: null };
          },
        };
        return b;
      },
    } as never,
  };
}

describe("funilDoNumero — o funil de entrada escolhido por número (migration 9430)", () => {
  it("número sem escolha devolve null (quem chama usa o funil padrão)", async () => {
    const { db, consultas } = banco((t) => (t === "channel_sessions" ? { entry_pipeline_id: null, entry_stage_id: null } : null));
    expect(await funilDoNumero(db, ORG, NUMERO)).toBeNull();
    // Não lê funil nenhum à toa.
    expect(consultas.map((c) => c.tabela)).toEqual(["channel_sessions"]);
  });

  it("funil e etapa escolhidos e válidos: o card nasce exatamente ali", async () => {
    const { db, consultas } = banco((t, f) => {
      if (t === "channel_sessions") return { entry_pipeline_id: FUNIL, entry_stage_id: ETAPA };
      if (t === "crm_pipelines") return { id: FUNIL, settings: {} };
      if (t === "crm_stages" && f.id === ETAPA) return { id: ETAPA };
      return null;
    });
    expect(await funilDoNumero(db, ORG, NUMERO)).toEqual({ pipelineId: FUNIL, stageId: ETAPA });
    // Toda leitura filtra a organização: a FK não conhece tenant.
    for (const c of consultas) expect(c.filtros.organization_id).toBe(ORG);
    const etapa = consultas.find((c) => c.tabela === "crm_stages");
    expect(etapa?.filtros).toMatchObject({ pipeline_id: FUNIL, is_archived: false, is_won: false, is_lost: false });
  });

  it("sem etapa escolhida: usa a primeira etapa aberta do funil", async () => {
    const { db } = banco((t) => {
      if (t === "channel_sessions") return { entry_pipeline_id: FUNIL, entry_stage_id: null };
      if (t === "crm_pipelines") return { id: FUNIL, settings: {} };
      if (t === "crm_stages") return { id: PRIMEIRA };
      return null;
    });
    expect(await funilDoNumero(db, ORG, NUMERO)).toEqual({ pipelineId: FUNIL, stageId: PRIMEIRA });
  });

  it("etapa escolhida que não serve mais (arquivada, ganho/perdido, outro funil): cai na primeira do funil", async () => {
    const { db } = banco((t, f) => {
      if (t === "channel_sessions") return { entry_pipeline_id: FUNIL, entry_stage_id: ETAPA };
      if (t === "crm_pipelines") return { id: FUNIL, settings: {} };
      if (t === "crm_stages") return f.id === ETAPA ? null : { id: PRIMEIRA };
      return null;
    });
    expect(await funilDoNumero(db, ORG, NUMERO)).toEqual({ pipelineId: FUNIL, stageId: PRIMEIRA });
  });

  it("funil arquivado ou de outra organização: devolve null e o card nasce no padrão", async () => {
    const { db } = banco((t) => (t === "channel_sessions" ? { entry_pipeline_id: FUNIL, entry_stage_id: ETAPA } : null));
    expect(await funilDoNumero(db, ORG, NUMERO)).toBeNull();
  });
});
