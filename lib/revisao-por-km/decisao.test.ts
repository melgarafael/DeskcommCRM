import { describe, expect, it, vi } from "vitest";

import { armarProximaRevisao, mexeuNaQuilometragem } from "@/lib/revisao-por-km/decisao";
import { casaNaData } from "@/lib/automation/gatilho-de-data-do-funil";
import { configuracaoDeRevisaoPorKm, somarDias } from "@/lib/revisao-por-km/conta";

/**
 * A ARMAÇÃO do aviso (#4376): a projeção vira ESCRITA no campo de data do
 * negócio, pelo caminho que já existe — e a data gravada é alcançável pelo
 * gatilho `lead.date_field_due`, no dia em que faltarem N dias.
 */

const CAMPOS_DO_FUNIL = [
  { key: "data_retirada", label: "Data da retirada", type: "date" },
  { key: "km_atual", label: "Km atual", type: "number" },
  { key: "proxima_revisao", label: "Próxima revisão", type: "date" },
  { key: "km_da_ultima_revisao", label: "Km da última revisão", type: "number" },
  { key: "data_da_ultima_revisao", label: "Data da última revisão", type: "date" },
] as const;

const SETTINGS = {
  fields: CAMPOS_DO_FUNIL,
  revisao_por_km: {
    campo_retirada: "data_retirada",
    campo_km: "km_atual",
    campo_saida: "proxima_revisao",
    campo_km_da_ultima_revisao: "km_da_ultima_revisao",
    campo_da_ultima_revisao: "data_da_ultima_revisao",
    intervalo_km: 10_000,
    prazo_meses: 12,
    dias_de_aviso: 30,
  },
};

/** A data de 3.000 km em 90 dias, no marco de 10 mil (ver `revisao-por-km.test.ts`). */
const DATA_PROJETADA = "2026-10-28";

describe("armarProximaRevisao", () => {
  it("grava a data prevista no campo de saída e o gatilho de 30 dias a alcança", async () => {
    const gravar = vi.fn(async () => true);

    const resultado = await armarProximaRevisao(
      {
        settings: SETTINGS,
        campos: { data_retirada: "2026-01-01", km_atual: "3000" },
        hoje: "2026-04-01",
      },
      gravar,
    );

    expect(resultado).toMatchObject({
      status: "armada",
      data: DATA_PROJETADA,
      campo: "proxima_revisao",
      dia_do_aviso: "2026-09-28",
    });
    expect(gravar).toHaveBeenCalledTimes(1);
    const [camposGravados] = gravar.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(camposGravados).toEqual({ proxima_revisao: DATA_PROJETADA });

    // O gatilho só emite no dia EXATO (`casaNaData`): com `dias: 30`, a regra
    // dispara 30 dias antes da data gravada — e só naquele dia.
    expect(casaNaData(DATA_PROJETADA, "2026-09-28", 30)).toBe(true);
    expect(casaNaData(DATA_PROJETADA, "2026-09-27", 30)).toBe(false);
  });

  it("BORDA km decrescente: não grava nada e a data já armada fica como está", async () => {
    const gravar = vi.fn(async () => true);

    const resultado = await armarProximaRevisao(
      {
        settings: SETTINGS,
        campos: {
          data_retirada: "2026-01-01",
          km_da_ultima_revisao: 10_500,
          data_da_ultima_revisao: "2026-03-01",
          km_atual: 9_000,
          proxima_revisao: "2027-03-01",
        },
        hoje: "2026-05-01",
      },
      gravar,
    );

    expect(resultado).toEqual({ status: "nenhuma_escrita", motivo: "km_sem_avanco" });
    expect(gravar).not.toHaveBeenCalled();
  });

  it("BORDA sem data de retirada: nenhuma escrita, e o motivo é explícito", async () => {
    const gravar = vi.fn(async () => true);

    const resultado = await armarProximaRevisao(
      { settings: SETTINGS, campos: { km_atual: 8_000 }, hoje: "2026-05-01" },
      gravar,
    );

    expect(resultado).toEqual({ status: "nenhuma_escrita", motivo: "sem_data_de_retirada" });
    expect(gravar).not.toHaveBeenCalled();
  });

  it("BORDA cliente que roda muito: a data gravada é hoje + 30, então o aviso sai hoje", async () => {
    const gravar = vi.fn(async () => true);

    const resultado = await armarProximaRevisao(
      {
        settings: SETTINGS,
        campos: { data_retirada: "2026-01-01", km_atual: "38000" },
        hoje: "2026-11-12",
      },
      gravar,
    );

    expect(resultado).toMatchObject({ status: "armada", data: "2026-12-12" });
    const [camposGravados] = gravar.mock.calls[0] as unknown as [Record<string, unknown>];
    // Nenhuma data no passado: o aviso que "venceria" sai HOJE.
    expect(casaNaData(camposGravados.proxima_revisao, "2026-11-12", 30)).toBe(true);
  });

  it("data igual à do card não gera escrita (um PATCH de título não rearma o aviso)", async () => {
    const gravar = vi.fn(async () => true);

    const resultado = await armarProximaRevisao(
      {
        settings: SETTINGS,
        campos: { data_retirada: "2026-01-01", km_atual: "3000", proxima_revisao: DATA_PROJETADA },
        hoje: "2026-04-01",
      },
      gravar,
    );

    expect(resultado).toEqual({ status: "nenhuma_escrita", motivo: "ja_gravada", detalhe: DATA_PROJETADA });
    expect(gravar).not.toHaveBeenCalled();
  });

  it("funil sem a configuração não escreve — a régua não foi pedida ali", async () => {
    const gravar = vi.fn(async () => true);

    const resultado = await armarProximaRevisao(
      { settings: { fields: CAMPOS_DO_FUNIL }, campos: { km_atual: 1 }, hoje: "2026-04-01" },
      gravar,
    );

    expect(resultado).toEqual({ status: "nenhuma_escrita", motivo: "sem_configuracao" });
    expect(gravar).not.toHaveBeenCalled();
  });

  it("escrita recusada pelo banco (card fechado/sumiu) não vira sucesso", async () => {
    const resultado = await armarProximaRevisao(
      {
        settings: SETTINGS,
        campos: { data_retirada: "2026-01-01", km_atual: "3000" },
        hoje: "2026-04-01",
      },
      async () => false,
    );

    expect(resultado).toEqual({ status: "falhou", motivo: "gravacao_recusada" });
  });
});

describe("mexeuNaQuilometragem", () => {
  const leitura = configuracaoDeRevisaoPorKm(SETTINGS);
  if (!leitura.ok) throw new Error("configuração de teste inválida");
  const config = leitura.config;

  it("km novo recalcula", () => {
    expect(mexeuNaQuilometragem(config, { km_atual: "3000" }, { km_atual: "6000" })).toBe(true);
  });

  it("campo que não é km não recalcula", () => {
    expect(mexeuNaQuilometragem(config, { km_atual: "3000" }, { km_atual: "3000" })).toBe(false);
  });

  it("sem leitura anterior a conta é feita", () => {
    expect(mexeuNaQuilometragem(config, undefined, { km_atual: "3000" })).toBe(true);
  });
});

describe("a data projetada cai num dia de calendário válido", () => {
  it("o dia do aviso é sempre 30 dias antes da data, inclusive na virada do ano", async () => {
    const gravar = vi.fn(async () => true);
    const resultado = await armarProximaRevisao(
      {
        settings: SETTINGS,
        campos: { data_retirada: "2026-01-15", km_atual: "2900" },
        hoje: "2026-12-20",
      },
      gravar,
    );
    expect(resultado.status).toBe("armada");
    if (resultado.status !== "armada") return;
    expect(resultado.dia_do_aviso).toBe(somarDias(resultado.data, -30));
  });
});
