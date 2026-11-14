/**
 * A REGRA da tarefa que se repete (#4595) — o que dá para provar SEM banco.
 *
 * O que este arquivo NÃO prova de propósito: idempotência. Ela é do índice
 * único `(recurrence_source_id, due_date)` e do `on conflict do nothing`, e
 * banco falso nenhum mostra isso — quem a prova é
 * `tests/invariants/tarefa-recorrente-nao-duplica.test.ts`, com Postgres de
 * verdade. Separação igual à de `lib/tarefas/plano.test.ts` ×
 * `tests/invariants/tarefas-piloto-pg.test.ts`.
 *
 * Aqui ficam as três perguntas que a pessoa faz ao criar a série:
 *  1. "toda segunda às 9h" cai na segunda certa, na hora certa?
 *  2. a hora é a do relógio da EMPRESA, não a do servidor?
 *  3. série desligada não gera nada?
 */
import { describe, expect, it } from "vitest";

import { normalizarRegra, proximaOcorrencia } from "./recorrencia";

/** Segunda-feira, 09:00 no fuso de Brasília. O caso da issue inteira. */
const SEGUNDA_9H_BRASILIA = new Date("2026-11-16T12:00:00.000Z");

const TODA_SEGUNDA_AS_9H = { dias: [1], hora: 9, ativa: true };

describe("normalizarRegra", () => {
  it("lê a regra como a tela grava", () => {
    expect(normalizarRegra({ dias: [5, 1, 1], hora: 9, ativa: true })).toEqual({
      dias: [1, 5],
      hora: 9,
      ativa: true,
    });
  });

  it("ausente, nulo ou torto NÃO é série", () => {
    expect(normalizarRegra(null)).toBeNull();
    expect(normalizarRegra(undefined)).toBeNull();
    expect(normalizarRegra("segunda")).toBeNull();
    expect(normalizarRegra([1, 9])).toBeNull();
  });

  it("dia fora de 0–6, hora fora de 0–23 e lista vazia derrubam SÓ esta série", () => {
    expect(normalizarRegra({ dias: [7], hora: 9, ativa: true })).toBeNull();
    expect(normalizarRegra({ dias: [1], hora: 24, ativa: true })).toBeNull();
    expect(normalizarRegra({ dias: [1], hora: "9" })).toBeNull();
    expect(normalizarRegra({ dias: [], hora: 9 })).toBeNull();
    expect(normalizarRegra({ dias: [-1, 2.5], hora: 9 })).toBeNull();
  });

  it("só `false` desliga — qualquer outro valor mantém a série ligada", () => {
    // Desligar por acidente é o erro caro: a pessoa deixaria de receber a
    // tarefa sem nunca ter pedido. Por isso o padrão é LIGADA.
    expect(normalizarRegra({ dias: [1], hora: 9 })?.ativa).toBe(true);
    expect(normalizarRegra({ dias: [1], hora: 9, ativa: "false" })?.ativa).toBe(true);
    expect(normalizarRegra({ dias: [1], hora: 9, ativa: false })?.ativa).toBe(false);
  });
});

describe("proximaOcorrencia — a regra de segunda às 9h", () => {
  it("de segunda antes das 9h, a próxima é a MESMA segunda às 9h", () => {
    // 08:00 em Brasília: a ocorrência de hoje ainda não chegou.
    const agora = new Date("2026-11-16T11:00:00.000Z");
    expect(proximaOcorrencia(TODA_SEGUNDA_AS_9H, agora, "America/Sao_Paulo")?.toISOString()).toBe(
      "2026-11-16T12:00:00.000Z",
    );
  });

  it("exatamente às 9h, a próxima é a SEGUNDA SEGUINTE (nunca a mesma)", () => {
    // A ocorrência de agora já nasceu; gerar "esta" de novo é a duplicata que
    // o critério da issue proíbe — e a régua é `>`, não `>=`.
    expect(
      proximaOcorrencia(TODA_SEGUNDA_AS_9H, SEGUNDA_9H_BRASILIA, "America/Sao_Paulo")?.toISOString(),
    ).toBe("2026-11-23T12:00:00.000Z");
  });

  it("de quarta, a próxima é a segunda que vem", () => {
    const quarta = new Date("2026-11-18T15:00:00.000Z");
    expect(proximaOcorrencia(TODA_SEGUNDA_AS_9H, quarta, "America/Sao_Paulo")?.toISOString()).toBe(
      "2026-11-23T12:00:00.000Z",
    );
  });

  it("com dois dias escolhidos, vale o PRÓXIMO da lista", () => {
    const tercaESexta = { dias: [2, 5], hora: 9, ativa: true };
    const segunda = new Date("2026-11-16T15:00:00.000Z");
    expect(proximaOcorrencia(tercaESexta, segunda, "America/Sao_Paulo")?.toISOString()).toBe(
      "2026-11-17T12:00:00.000Z",
    );
  });

  it("série desligada não tem próxima ocorrência", () => {
    expect(
      proximaOcorrencia({ ...TODA_SEGUNDA_AS_9H, ativa: false }, SEGUNDA_9H_BRASILIA, "America/Sao_Paulo"),
    ).toBeNull();
  });
});

describe("proximaOcorrencia — o fuso é o da ORGANIZAÇÃO", () => {
  it("trocar o fuso muda o INSTANTE e mantém a hora de parede", () => {
    // Mesma regra, dois fusos: 9h em Brasília é 12:00Z; 9h em Manaus (UTC-4) é
    // 13:00Z. Se a conta fosse feita em UTC, os dois dariam 09:00Z e a ligação
    // das 9h aconteceria às 6h em Brasília — o defeito que a issue proíbe.
    const agora = new Date("2026-11-16T00:00:00.000Z");
    expect(proximaOcorrencia(TODA_SEGUNDA_AS_9H, agora, "America/Sao_Paulo")?.toISOString()).toBe(
      "2026-11-16T12:00:00.000Z",
    );
    expect(proximaOcorrencia(TODA_SEGUNDA_AS_9H, agora, "America/Manaus")?.toISOString()).toBe(
      "2026-11-16T13:00:00.000Z",
    );
  });

  it("o dia da semana é o do relógio da organização, não o do servidor", () => {
    // 2026-11-17T02:00Z ainda é SEGUNDA (23:00) em Brasília. Uma varredura que
    // olhasse o dia em UTC acharia terça e pularia a série por uma semana.
    const agora = new Date("2026-11-17T02:00:00.000Z");
    expect(proximaOcorrencia(TODA_SEGUNDA_AS_9H, agora, "America/Sao_Paulo")?.toISOString()).toBe(
      "2026-11-23T12:00:00.000Z",
    );
  });
});
