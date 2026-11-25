/**
 * Os limites de resposta que o TikTok impõe (A21): janela de 48 h, teto de 10
 * mensagens e a reserva de 2 para a equipe. Função pura — o que se prende aqui é
 * a conta, nas bordas onde ela costuma errar por um.
 */
import { describe, expect, it } from "vitest";

import { decidirLimiteDaRede, limitesDaRede, LIMITES_POR_REDE_SOCIAL, politicaDaRede } from "./limites-da-rede";

const HORA = 60 * 60 * 1000;
const AGORA = new Date("2026-11-25T12:00:00.000Z");
const tiktok = limitesDaRede("tiktok")!;

function entrada(parcial: { autor?: "ia" | "equipe"; respostas?: number; ultimaHaHoras?: number | null }) {
  const horasAtras = parcial.ultimaHaHoras === undefined ? 1 : parcial.ultimaHaHoras;
  return {
    limites: tiktok,
    autor: parcial.autor ?? "equipe",
    respostasNaJanela: parcial.respostas ?? 0,
    lastInboundAt: horasAtras === null ? null : new Date(AGORA.getTime() - horasAtras * HORA),
    now: AGORA,
  } as const;
}

describe("limitesDaRede", () => {
  it("o TikTok tem janela de 48 h, teto de 10 e reserva de 2 para a equipe", () => {
    expect(tiktok).toEqual({
      janelaMs: 48 * HORA,
      maxRespostas: 10,
      reservaParaEquipe: 2,
    });
    // a escolha das 2 fotos é política NOSSA, fora da física da rede
    expect(politicaDaRede("tiktok")).toEqual({ fotosPorTurnoDaIa: 2 });
    expect(politicaDaRede("instagram")).toBeNull();
    expect(politicaDaRede("constructor")).toBeNull();
  });

  it("rede sem limite medido, vazia ou fora do mapa responde null — e o protótipo não vaza", () => {
    for (const rede of ["instagram", "facebook", "", null, undefined, "constructor", "__proto__", "toString"]) {
      expect(limitesDaRede(rede), String(rede)).toBeNull();
    }
    expect(Object.keys(LIMITES_POR_REDE_SOCIAL)).toEqual(["tiktok"]);
  });
});

describe("decidirLimiteDaRede: a janela de 48 h", () => {
  it("passa um instante antes das 48 h e fecha em 48 h exatas (borda exclusiva)", () => {
    expect(decidirLimiteDaRede(entrada({ ultimaHaHoras: 47.99 })).permitido).toBe(true);
    const fechada = decidirLimiteDaRede(entrada({ ultimaHaHoras: 48 }));
    expect(fechada).toMatchObject({ permitido: false, codigo: "janela_da_rede_fechada" });
  });

  it("cliente que nunca escreveu não tem janela: fechada para a IA e para a equipe", () => {
    for (const autor of ["ia", "equipe"] as const) {
      expect(decidirLimiteDaRede(entrada({ autor, ultimaHaHoras: null }))).toMatchObject({
        permitido: false,
        codigo: "janela_da_rede_fechada",
      });
    }
  });

  it("a mensagem de janela fechada diz o que fazer, em português", () => {
    const v = decidirLimiteDaRede(entrada({ ultimaHaHoras: 60 }));
    expect(v.permitido).toBe(false);
    if (!v.permitido) expect(v.mensagem).toMatch(/48 h.*cliente escrever de novo/);
  });
});

describe("decidirLimiteDaRede: o teto de 10 e a reserva da equipe", () => {
  it("a IA responde até a 8ª (7 já enviadas) e é barrada com 8 enviadas", () => {
    expect(decidirLimiteDaRede(entrada({ autor: "ia", respostas: 7 })).permitido).toBe(true);
    expect(decidirLimiteDaRede(entrada({ autor: "ia", respostas: 8 }))).toMatchObject({
      permitido: false,
      codigo: "reserva_da_equipe",
    });
  });

  it("a equipe usa as 2 últimas: passa com 8 e com 9 enviadas, e é barrada com 10", () => {
    expect(decidirLimiteDaRede(entrada({ autor: "equipe", respostas: 8 })).permitido).toBe(true);
    expect(decidirLimiteDaRede(entrada({ autor: "equipe", respostas: 9 })).permitido).toBe(true);
    expect(decidirLimiteDaRede(entrada({ autor: "equipe", respostas: 10 }))).toMatchObject({
      permitido: false,
      codigo: "teto_da_rede",
    });
  });

  it("com o teto estourado a IA também recebe `teto_da_rede` (o mais grave vence a reserva)", () => {
    expect(decidirLimiteDaRede(entrada({ autor: "ia", respostas: 10 }))).toMatchObject({
      codigo: "teto_da_rede",
    });
    expect(decidirLimiteDaRede(entrada({ autor: "ia", respostas: 15 }))).toMatchObject({
      codigo: "teto_da_rede",
    });
  });

  it("o texto do teto traz o número e o prazo; o da reserva manda deixar para uma pessoa", () => {
    const teto = decidirLimiteDaRede(entrada({ autor: "equipe", respostas: 10 }));
    if (!teto.permitido) expect(teto.mensagem).toMatch(/10 respostas em 48 h/);
    const reserva = decidirLimiteDaRede(entrada({ autor: "ia", respostas: 8 }));
    if (!reserva.permitido) {
      expect(reserva.mensagem).toMatch(/8 das 10/);
      expect(reserva.mensagem).toMatch(/Encerre o turno e deixe a conversa para uma pessoa/);
    }
  });

  it("a janela fechada vence a contagem: conversa velha com zero respostas segue barrada", () => {
    expect(decidirLimiteDaRede(entrada({ respostas: 0, ultimaHaHoras: 72 }))).toMatchObject({
      codigo: "janela_da_rede_fechada",
    });
  });
});

describe("decidirLimiteDaRede: carimbo do cliente no futuro", () => {
  it("desvio pequeno de relógio (1 min à frente) vale como acabou de escrever", () => {
    expect(decidirLimiteDaRede(entrada({ ultimaHaHoras: -1 / 60 })).permitido).toBe(true);
  });
  it("carimbo 1 h à frente não é confiável: janela fechada, nunca mais larga", () => {
    const v = decidirLimiteDaRede(entrada({ ultimaHaHoras: -1 }));
    expect(v.permitido).toBe(false);
    expect(v).toMatchObject({ codigo: "janela_da_rede_fechada" });
  });
});
