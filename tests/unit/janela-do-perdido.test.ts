import { describe, expect, it } from "vitest";

import {
  DIAS_MAXIMO_PARA_REABRIR,
  DIAS_MINIMO_PARA_REABRIR,
  DIAS_PADRAO_PARA_REABRIR,
  diasParaReabrirPerdido,
  perdidoDentroDaJanela,
} from "@/lib/leads/janela-do-perdido";

/**
 * A RÉGUA DA JANELA (#4076), sem banco.
 *
 * A janela é o que separa "o cliente respondeu à despedida" de "o cliente
 * voltou no trimestre seguinte": reabrir o perdido de meses atrás apagaria a
 * leitura de rotatividade do funil (o card volta a `aberto` com a idade da
 * PRIMEIRA tentativa, e a perda deixa de ser contada). Por isso o que se mede
 * aqui são os LIMITES, que é onde a régua costuma escorregar: chave ausente,
 * `0` (desligado), número fracionário, texto, fora da faixa e data inexistente.
 *
 * Roda sem Postgres de propósito: são decisões puras, e um teste que exigisse
 * container esconderia a tabela de casos atrás de 40 segundos de subida.
 */
const AGORA = new Date("2026-11-05T12:00:00.000Z");

describe("diasParaReabrirPerdido — a opção, ou null quando está desligada", () => {
  it("chave ausente é DESLIGADA — todo funil de hoje cai aqui", () => {
    expect(diasParaReabrirPerdido({})).toBeNull();
    expect(diasParaReabrirPerdido(null)).toBeNull();
    expect(diasParaReabrirPerdido(undefined)).toBeNull();
  });

  it("`0` é DESLIGADO, não 'reabra o de hoje'", () => {
    expect(diasParaReabrirPerdido({ reabrir_perdido_dias: 0 })).toBeNull();
  });

  it("valor dentro da faixa é o número configurado", () => {
    expect(diasParaReabrirPerdido({ reabrir_perdido_dias: DIAS_MINIMO_PARA_REABRIR })).toBe(1);
    expect(diasParaReabrirPerdido({ reabrir_perdido_dias: DIAS_PADRAO_PARA_REABRIR })).toBe(30);
    expect(diasParaReabrirPerdido({ reabrir_perdido_dias: DIAS_MAXIMO_PARA_REABRIR })).toBe(3650);
  });

  it("fora da faixa, fracionário ou texto NÃO abre janela nenhuma", () => {
    // Linha editada à mão não pode virar janela infinita: um número absurdo
    // reabriria um card de outra década como se a conversa continuasse.
    expect(diasParaReabrirPerdido({ reabrir_perdido_dias: -1 })).toBeNull();
    expect(
      diasParaReabrirPerdido({ reabrir_perdido_dias: DIAS_MAXIMO_PARA_REABRIR + 1 }),
    ).toBeNull();
    expect(diasParaReabrirPerdido({ reabrir_perdido_dias: 1.5 })).toBeNull();
    expect(diasParaReabrirPerdido({ reabrir_perdido_dias: "30" })).toBeNull();
    expect(diasParaReabrirPerdido({ reabrir_perdido_dias: null })).toBeNull();
    expect(diasParaReabrirPerdido({ reabrir_perdido_dias: true })).toBeNull();
  });
});

describe("perdidoDentroDaJanela — a data da perda, contra a janela", () => {
  it("perdido há 5 minutos está dentro de 30 dias", () => {
    expect(perdidoDentroDaJanela("2026-11-05T11:55:00.000Z", 30, AGORA)).toBe(true);
  });

  it("perdido há 60 dias está FORA de 30 — é o caso que a issue exige criar card novo", () => {
    expect(perdidoDentroDaJanela("2026-09-06T12:00:00.000Z", 30, AGORA)).toBe(false);
  });

  it("o limite é INCLUSIVO: exatamente 30 dias atrás ainda reabre", () => {
    // Inclusivo de propósito: a comparação é a mesma de `recortaEncerrados`,
    // e um limite exclusivo faria o comportamento mudar por um milissegundo
    // de relógio — impossível de explicar para quem opera.
    expect(perdidoDentroDaJanela("2026-10-06T12:00:00.000Z", 30, AGORA)).toBe(true);
    expect(perdidoDentroDaJanela("2026-10-06T11:59:59.999Z", 30, AGORA)).toBe(false);
  });

  it("data ausente ou ilegível conta como FORA — não se inventa recência", () => {
    // `closed_at` nulo só existe em dado legado (o CHECK exige data para
    // `lost`). Tratar ausência como "recente" reabriria justamente o card
    // antigo que a janela existe para não reabrir.
    expect(perdidoDentroDaJanela(null, 30, AGORA)).toBe(false);
    expect(perdidoDentroDaJanela(undefined, 30, AGORA)).toBe(false);
    expect(perdidoDentroDaJanela("ontem", 30, AGORA)).toBe(false);
  });
});
