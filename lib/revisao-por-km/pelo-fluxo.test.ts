import { afterEach, describe, expect, it, vi } from "vitest";

// Adaptação para módulo opcional: aqui o módulo está LIGADO. O caminho
// desligado (e a contagem de idas ao banco dele) é medido em `modulo.test.ts`.
vi.mock("@/lib/revisao-por-km/modulo", () => ({
  revisaoPorKmLigada: vi.fn(async () => true),
  revisaoPorKmLigadaComMemo: vi.fn(async () => true),
}));

import { armarProximaRevisaoPeloFluxo } from "@/lib/revisao-por-km/pelo-fluxo";
import { casaNaData } from "@/lib/automation/gatilho-de-data-do-funil";

/**
 * A PORTA DA CAPTURA DO FLUXO (#4376): a resposta "quantos km?" chega pelo
 * roteiro, é gravada no card (`destino: 'negocio'`, #3363) — e a revisão é
 * armada na sequência, pelo `fn_lead_anotar_campos`.
 *
 * O dublê de `query` responde as duas consultas do caminho: a leitura única
 * (negócio + funil + fuso) e a escrita pela função do banco.
 */

const CAMPOS_DO_FUNIL = [
  { key: "data_retirada", label: "Data da retirada", type: "date" },
  { key: "km_atual", label: "Km atual", type: "number" },
  { key: "proxima_revisao", label: "Próxima revisão", type: "date" },
];

const SETTINGS = {
  fields: CAMPOS_DO_FUNIL,
  revisao_por_km: {
    campo_retirada: "data_retirada",
    campo_km: "km_atual",
    campo_saida: "proxima_revisao",
    intervalo_km: 10_000,
    prazo_meses: 12,
    dias_de_aviso: 30,
  },
};

interface Cenario {
  campos: Record<string, unknown>;
  settings: Record<string, unknown>;
  fuso?: string | null;
  /** Resultado da segunda consulta (a escrita). */
  escreveu?: unknown;
}

function bancoDe(cenario: Cenario) {
  const chamadas: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    chamadas.push({ sql, params });
    if (sql.includes("fn_lead_anotar_campos")) {
      return { rows: [{ campos: cenario.escreveu === undefined ? {} : cenario.escreveu }] };
    }
    return { rows: [{ campos: cenario.campos, settings: cenario.settings, fuso: cenario.fuso ?? "America/Sao_Paulo" }] };
  });
  return { db: { query }, chamadas };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("armarProximaRevisaoPeloFluxo", () => {
  it("depois da resposta de km, grava a data prevista pela função do banco", async () => {
    // 2026-04-01 12:00 UTC = 09:00 em São Paulo: o dia da organização é 1º/abril.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-04-01T12:00:00Z"));

    const { db, chamadas } = bancoDe({
      campos: { data_retirada: "2026-01-01", km_atual: "3000" },
      settings: SETTINGS,
      escreveu: { data_retirada: "2026-01-01", km_atual: "3000", proxima_revisao: "2026-10-28" },
    });

    const resultado = await armarProximaRevisaoPeloFluxo(db, {
      organizationId: "org-1",
      leadId: "lead-1",
      campoGravado: "km_atual",
    });

    expect(resultado).toMatchObject({
      status: "armada",
      data: "2026-10-28",
      campo: "proxima_revisao",
    });
    const escrita = chamadas.find((c) => c.sql.includes("fn_lead_anotar_campos"));
    expect(escrita).toBeDefined();
    expect(escrita!.params).toEqual(["org-1", "lead-1", JSON.stringify({ proxima_revisao: "2026-10-28" })]);
    // O gatilho de 30 dias alcança a data: o aviso sai em 28/09/2026.
    expect(casaNaData("2026-10-28", "2026-09-28", 30)).toBe(true);
  });

  it("resposta que não é km não recalcula revisão (nem rearma o aviso)", async () => {
    const { db, chamadas } = bancoDe({
      campos: { data_retirada: "2026-01-01", km_atual: "3000" },
      settings: SETTINGS,
    });

    const resultado = await armarProximaRevisaoPeloFluxo(db, {
      organizationId: "org-1",
      leadId: "lead-1",
      campoGravado: "cidade",
    });

    expect(resultado).toEqual({ status: "nenhuma_escrita", motivo: "sem_km", detalhe: "cidade" });
    expect(chamadas.some((c) => c.sql.includes("fn_lead_anotar_campos"))).toBe(false);
  });

  it("funil sem a configuração: nenhuma escrita", async () => {
    const { db, chamadas } = bancoDe({
      campos: { data_retirada: "2026-01-01", km_atual: "3000" },
      settings: { fields: CAMPOS_DO_FUNIL },
    });

    const resultado = await armarProximaRevisaoPeloFluxo(db, {
      organizationId: "org-1",
      leadId: "lead-1",
      campoGravado: "km_atual",
    });

    expect(resultado).toEqual({ status: "nenhuma_escrita", motivo: "sem_configuracao" });
    expect(chamadas.some((c) => c.sql.includes("fn_lead_anotar_campos"))).toBe(false);
  });

  it("BORDA km decrescente no fluxo: não grava e preserva a data do card", async () => {
    const { db, chamadas } = bancoDe({
      campos: {
        data_retirada: "2026-01-01",
        km_atual: 9_000,
        proxima_revisao: "2026-10-28",
      },
      settings: {
        fields: CAMPOS_DO_FUNIL,
        revisao_por_km: { ...(SETTINGS.revisao_por_km as object), campo_km_da_ultima_revisao: undefined },
      },
    });

    const resultado = await armarProximaRevisaoPeloFluxo(db, {
      organizationId: "org-1",
      leadId: "lead-1",
      campoGravado: "km_atual",
    });

    // Sem revisão anterior configurada a base é a retirada (km 0): 9.000 km é
    // avanço legítimo. O caso decrescente de verdade está coberto em
    // `decisao.test.ts`, com a última revisão no card.
    expect(resultado.status).toBe("armada");
    expect(chamadas.some((c) => c.sql.includes("fn_lead_anotar_campos"))).toBe(true);
  });

  it("card fechado/sumido: a função do banco devolve null e nada é anunciado", async () => {
    const { db } = bancoDe({
      campos: { data_retirada: "2026-01-01", km_atual: "3000" },
      settings: SETTINGS,
      escreveu: null,
    });

    const resultado = await armarProximaRevisaoPeloFluxo(db, {
      organizationId: "org-1",
      leadId: "lead-1",
      campoGravado: "km_atual",
    });

    expect(resultado).toEqual({ status: "falhou", motivo: "gravacao_recusada" });
  });

  it("negócio que não está mais aberto não é lido", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const resultado = await armarProximaRevisaoPeloFluxo({ query }, {
      organizationId: "org-1",
      leadId: "lead-1",
      campoGravado: "km_atual",
    });

    expect(resultado).toEqual({ status: "nenhuma_escrita", motivo: "sem_km" });
  });
});
