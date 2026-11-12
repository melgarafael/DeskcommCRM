import { describe, expect, it, vi } from "vitest";

import { armarProximaRevisaoNoCard } from "@/lib/leads/armar-proxima-revisao-no-card";
import { casaNaData } from "@/lib/automation/gatilho-de-data-do-funil";

/**
 * A PORTA DO CARD (#4376): o PATCH do negócio (tela, API, MCP, webhook de
 * entrada) grava o km e a data prevista é armada na mesma passada — no fuso da
 * ORGANIZAÇÃO, com a função do banco que já grava `custom_fields`.
 *
 * O caso que discrimina: 01/04/2026 às 01h UTC ainda é 31/03 em São Paulo. Um
 * "hoje" do servidor projetaria um dia a mais e o aviso sairia no dia errado.
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

function portas(fuso: string | null = "America/Sao_Paulo", falhaNoFuso = false) {
  const gravados: Array<Record<string, unknown>> = [];
  return {
    gravados,
    portas: {
      fusoDaOrganizacao: vi.fn(async () => {
        if (falhaNoFuso) throw new Error("organizations indisponível");
        return fuso;
      }),
      gravarCampos: vi.fn(async (campos: Record<string, unknown>) => {
        gravados.push(campos);
        return true;
      }),
    },
  };
}

describe("armarProximaRevisaoNoCard", () => {
  it("grava a data prevista usando o dia da ORGANIZAÇÃO, não o do servidor", async () => {
    const { portas: p, gravados } = portas();

    const resultado = await armarProximaRevisaoNoCard({
      settings: SETTINGS,
      campos: { data_retirada: "2026-01-01", km_atual: "3000" },
      portas: p,
      // 01/04/2026 01:00 UTC = 31/03/2026 22:00 em São Paulo.
      agora: new Date("2026-04-01T01:00:00Z"),
    });

    expect(resultado).toMatchObject({ status: "armada", data: "2026-10-25", campo: "proxima_revisao" });
    expect(gravados).toEqual([{ proxima_revisao: "2026-10-25" }]);
    // O gatilho de 30 dias dispara no dia certo — 25/09/2026.
    expect(casaNaData("2026-10-25", "2026-09-25", 30)).toBe(true);
  });

  it("fuso ilegível não impede a data de ser gravada (cai no padrão do produto)", async () => {
    const { portas: p, gravados } = portas(null, true);

    const resultado = await armarProximaRevisaoNoCard({
      settings: SETTINGS,
      campos: { data_retirada: "2026-01-01", km_atual: "3000" },
      portas: p,
      agora: new Date("2026-04-01T12:00:00Z"),
    });

    expect(resultado).toMatchObject({ status: "armada", data: "2026-10-28" });
    expect(gravados).toEqual([{ proxima_revisao: "2026-10-28" }]);
  });

  it("edição que não mexeu no km não grava de novo (nem rearma o aviso)", async () => {
    const { portas: p, gravados } = portas();

    const resultado = await armarProximaRevisaoNoCard({
      settings: SETTINGS,
      camposAnteriores: { data_retirada: "2026-01-01", km_atual: "3000" },
      campos: { data_retirada: "2026-01-01", km_atual: "3000" },
      portas: p,
      agora: new Date("2026-04-01T12:00:00Z"),
    });

    expect(resultado).toEqual({ status: "nenhuma_escrita", motivo: "ja_gravada" });
    expect(gravados).toEqual([]);
  });

  it("km novo na mesma semana projeta de novo e a data muda (o aviso rearma)", async () => {
    const { portas: p, gravados } = portas();

    const resultado = await armarProximaRevisaoNoCard({
      settings: SETTINGS,
      camposAnteriores: { data_retirada: "2026-01-01", km_atual: "3000", proxima_revisao: "2026-10-28" },
      campos: { data_retirada: "2026-01-01", km_atual: "6000", proxima_revisao: "2026-10-28" },
      portas: p,
      agora: new Date("2026-06-01T12:00:00Z"),
    });

    expect(resultado.status).toBe("armada");
    // 6.000 km em 151 dias = 39,7 km/dia; faltam 4.000 km = 101 dias.
    expect(gravados).toEqual([{ proxima_revisao: "2026-09-10" }]);
  });

  it("BORDA sem data de retirada: não grava e o motivo volta nomeado", async () => {
    const { portas: p, gravados } = portas();

    const resultado = await armarProximaRevisaoNoCard({
      settings: SETTINGS,
      campos: { km_atual: "8000" },
      portas: p,
      agora: new Date("2026-04-01T12:00:00Z"),
    });

    expect(resultado).toEqual({ status: "nenhuma_escrita", motivo: "sem_data_de_retirada" });
    expect(gravados).toEqual([]);
  });
});
