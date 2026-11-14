import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ZERO MÓDULOS LIGADOS É ESTADO DE PRIMEIRA CLASSE (adaptação do #4536, #4376).
 *
 * Com `MODULO_REVISAO_POR_KM` ausente (o padrão), as duas portas que o núcleo
 * chama têm de custar o que custavam na `main`: a do card não pode ler nada a
 * mais, e a do roteiro (o caminho quente do WhatsApp) não pode tocar no pool
 * `pg` a mais. Aqui o portão é dublê controlável, e cada ida ao banco é contada.
 */
const portao = vi.hoisted(() => ({
  ligada: vi.fn(async () => false),
  ligadaComMemo: vi.fn(async () => false),
}));
vi.mock("@/lib/revisao-por-km/modulo", () => ({
  revisaoPorKmLigada: portao.ligada,
  revisaoPorKmLigadaComMemo: portao.ligadaComMemo,
}));

import { armarProximaRevisaoNoCard } from "@/lib/revisao-por-km/no-card";
import { armarProximaRevisaoPeloFluxo } from "@/lib/revisao-por-km/pelo-fluxo";
import { gravarRespostaNoNegocio } from "@/lib/followup/atendimento";

const ORG = "00000000-0000-4000-8000-0000000000a1";
const LEAD = "00000000-0000-4000-8000-0000000000b2";
const CONTATO = "00000000-0000-4000-8000-0000000000c3";

const SETTINGS_COM_REGUA = {
  fields: [
    { key: "data_retirada", label: "Data da retirada", type: "date" },
    { key: "km_atual", label: "Km atual", type: "number" },
    { key: "proxima_revisao", label: "Próxima revisão", type: "date" },
  ],
  revisao_por_km: {
    campo_retirada: "data_retirada",
    campo_km: "km_atual",
    campo_saida: "proxima_revisao",
    intervalo_km: 10_000,
    prazo_meses: 12,
    dias_de_aviso: 30,
  },
};

function portasContadas() {
  return {
    fusoDaOrganizacao: vi.fn(async () => "America/Sao_Paulo"),
    gravarCampos: vi.fn(async () => true),
  };
}

/** Dublê do pool `pg` que conta TODA consulta. */
function poolContado(opts: { rowCountDoUpdate?: number; falhaNaLeitura?: boolean; settings?: unknown } = {}) {
  const consultas: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    consultas.push({ sql, params });
    if (/update crm_leads/.test(sql)) return { rows: [], rowCount: opts.rowCountDoUpdate ?? 1 };
    if (/fn_lead_anotar_campos/.test(sql)) return { rows: [{ campos: {} }], rowCount: 1 };
    if (opts.falhaNaLeitura) throw new Error("conexão caiu");
    return {
      rows: [
        {
          campos: { data_retirada: "2026-01-01", km_atual: "3000" },
          settings: opts.settings ?? SETTINGS_COM_REGUA,
          fuso: "America/Sao_Paulo",
        },
      ],
      rowCount: 1,
    };
  });
  return { db: { query } as never, consultas };
}

beforeEach(() => {
  portao.ligada.mockReset().mockResolvedValue(false);
  portao.ligadaComMemo.mockReset().mockResolvedValue(false);
});

describe("porta do CARD com o módulo desligado", () => {
  it("funil SEM a régua: nem o portão é consultado — zero leitura a mais que a main", async () => {
    const portas = portasContadas();
    const r = await armarProximaRevisaoNoCard({
      settings: { fields: SETTINGS_COM_REGUA.fields },
      campos: { km_atual: "3000" },
      portas,
    });
    expect(r).toEqual({ status: "nenhuma_escrita", motivo: "sem_configuracao" });
    expect(portao.ligada).not.toHaveBeenCalled();
    expect(portas.fusoDaOrganizacao).not.toHaveBeenCalled();
    expect(portas.gravarCampos).not.toHaveBeenCalled();
  });

  it("settings nulo (funil ilegível): sai sem consultar nada", async () => {
    const portas = portasContadas();
    const r = await armarProximaRevisaoNoCard({ settings: null, campos: { km_atual: "3000" }, portas });
    expect(r.status).toBe("nenhuma_escrita");
    expect(portao.ligada).not.toHaveBeenCalled();
    expect(portas.fusoDaOrganizacao).not.toHaveBeenCalled();
  });

  it("funil COM a régua e instalação desligada: o portão decide e nada mais é lido nem gravado", async () => {
    const portas = portasContadas();
    const r = await armarProximaRevisaoNoCard({
      settings: SETTINGS_COM_REGUA,
      campos: { data_retirada: "2026-01-01", km_atual: "3000" },
      portas,
    });
    expect(r).toEqual({ status: "nenhuma_escrita", motivo: "modulo_desligado" });
    expect(portao.ligada).toHaveBeenCalledTimes(1);
    expect(portas.fusoDaOrganizacao).not.toHaveBeenCalled();
    expect(portas.gravarCampos).not.toHaveBeenCalled();
  });

  it("controle: com o módulo ligado, a mesma entrada grava (o portão não é um 'sempre não')", async () => {
    portao.ligada.mockResolvedValue(true);
    const portas = portasContadas();
    const r = await armarProximaRevisaoNoCard({
      settings: SETTINGS_COM_REGUA,
      campos: { data_retirada: "2026-01-01", km_atual: "3000" },
      portas,
      agora: new Date("2026-04-01T12:00:00Z"),
    });
    expect(r).toMatchObject({ status: "armada", data: "2026-10-28" });
    expect(portas.gravarCampos).toHaveBeenCalledTimes(1);
  });
});

describe("porta do ROTEIRO com o módulo desligado", () => {
  it("o portão vem ANTES da leitura do negócio: zero consulta no pool", async () => {
    const { db, consultas } = poolContado();
    const r = await armarProximaRevisaoPeloFluxo(db, { organizationId: ORG, leadId: LEAD, campoGravado: "km_atual" });
    expect(r).toEqual({ status: "nenhuma_escrita", motivo: "modulo_desligado" });
    expect(consultas).toHaveLength(0);
    expect(portao.ligadaComMemo).toHaveBeenCalledTimes(1);
  });

  it("o roteiro usa a leitura COM memo (caminho quente), nunca a sem memo", async () => {
    const { db } = poolContado();
    await armarProximaRevisaoPeloFluxo(db, { organizationId: ORG, leadId: LEAD });
    expect(portao.ligadaComMemo).toHaveBeenCalled();
    expect(portao.ligada).not.toHaveBeenCalled();
  });
});

describe("gravarRespostaNoNegocio — o retorno reestruturado continua o mesmo", () => {
  const args = { organizationId: ORG, contactId: CONTATO, leadId: LEAD, campo: "km_atual", valor: "3000" };

  it("desligado + gravou: true, e o pool vê UMA consulta (o update), como na main", async () => {
    const { db, consultas } = poolContado();
    expect(await gravarRespostaNoNegocio(db, args)).toBe(true);
    expect(consultas).toHaveLength(1);
    expect(consultas[0]!.sql).toMatch(/update crm_leads/);
  });

  it("não gravou (card fechado/contato anonimizado): false, e o portão nem é consultado", async () => {
    const { db, consultas } = poolContado({ rowCountDoUpdate: 0 });
    expect(await gravarRespostaNoNegocio(db, args)).toBe(false);
    expect(consultas).toHaveLength(1);
    expect(portao.ligadaComMemo).not.toHaveBeenCalled();
  });

  it("rowCount ausente (null) continua sendo 'não gravou'", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: null }));
    expect(await gravarRespostaNoNegocio({ query } as never, args)).toBe(false);
  });

  it("ligado + gravou: true, e a projeção grava com o organizationId do roteiro, nunca de outro lugar", async () => {
    portao.ligadaComMemo.mockResolvedValue(true);
    const { db, consultas } = poolContado();
    expect(await gravarRespostaNoNegocio(db, args)).toBe(true);
    const leitura = consultas.find((c) => /from crm_leads l/.test(c.sql));
    const escrita = consultas.find((c) => /fn_lead_anotar_campos/.test(c.sql));
    expect(leitura?.params.slice(0, 2)).toEqual([ORG, LEAD]);
    expect(escrita?.params.slice(0, 2)).toEqual([ORG, LEAD]);
  });

  it("ligado + a projeção falha no banco: o km já gravado não cai — true", async () => {
    portao.ligadaComMemo.mockResolvedValue(true);
    const { db } = poolContado({ falhaNaLeitura: true });
    expect(await gravarRespostaNoNegocio(db, args)).toBe(true);
  });

  it("ligado + o portão lança: o km já gravado não cai — true", async () => {
    portao.ligadaComMemo.mockRejectedValue(new Error("inesperado"));
    const { db } = poolContado();
    expect(await gravarRespostaNoNegocio(db, args)).toBe(true);
  });
});
