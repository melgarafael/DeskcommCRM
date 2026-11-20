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
 * Aqui ficam as perguntas que a pessoa faz ao criar a série:
 *  1. "toda segunda às 9h" cai na segunda certa, na hora certa?
 *  2. "todo dia" e "todo dia 5" caem no dia certo — inclusive em mês curto?
 *  3. a hora é a do relógio da EMPRESA, não a do servidor?
 *  4. série desligada não gera nada?
 */
import { describe, expect, it } from "vitest";

import { normalizarRegra, proximaOcorrencia, regraParaGravar } from "./recorrencia";
import type { RegraDeRecorrencia } from "./tipos";

/** Segunda-feira, 09:00 no fuso de Brasília. O caso da issue inteira. */
const SEGUNDA_9H_BRASILIA = new Date("2026-11-16T12:00:00.000Z");
/** Segunda-feira, 08:00 em Brasília — antes das 9h da série. */
const SEGUNDA_8H_BRASILIA = new Date("2026-11-16T11:00:00.000Z");

const TODA_SEGUNDA_AS_9H: RegraDeRecorrencia = {
  tipo: "semanal",
  dias: [1],
  dia_do_mes: null,
  hora: 9,
  ativa: true,
};

describe("normalizarRegra", () => {
  it("lê a regra semanal como a tela grava, com os dias ordenados e sem repetição", () => {
    expect(normalizarRegra({ tipo: "semanal", dias: [5, 1, 1], hora: 9, ativa: true })).toEqual({
      tipo: "semanal",
      dias: [1, 5],
      dia_do_mes: null,
      hora: 9,
      ativa: true,
    });
  });

  it("guarda o TIPO: 'diária' e 'semanal com os sete dias' não se confundem", () => {
    // As duas produzem as mesmas datas hoje. Sem o tipo gravado, abrir a diária
    // para editar mostraria os sete dias marcados e a pessoa não saberia o que
    // tinha escolhido.
    const diaria = normalizarRegra({ tipo: "diaria", dias: [0, 1, 2, 3, 4, 5, 6], hora: 8 });
    expect(diaria).toEqual({ tipo: "diaria", dias: [], dia_do_mes: null, hora: 8, ativa: true });

    const semanal = normalizarRegra({ tipo: "semanal", dias: [0, 1, 2, 3, 4, 5, 6], hora: 8 });
    expect(semanal?.tipo).toBe("semanal");
    expect(semanal?.dias).toHaveLength(7);
  });

  it("mensal exige dia do mês; sem ele a série é inválida (não gera em lugar nenhum)", () => {
    expect(normalizarRegra({ tipo: "mensal", dia_do_mes: 5, hora: 9 })).toEqual({
      tipo: "mensal",
      dias: [],
      dia_do_mes: 5,
      hora: 9,
      ativa: true,
    });
    expect(normalizarRegra({ tipo: "mensal", hora: 9 })).toBeNull();
    expect(normalizarRegra({ tipo: "mensal", dia_do_mes: 0, hora: 9 })).toBeNull();
    expect(normalizarRegra({ tipo: "mensal", dia_do_mes: 32, hora: 9 })).toBeNull();
  });

  it("regra gravada ANTES do campo `tipo` é semanal — o histórico não vira lixo", () => {
    expect(normalizarRegra({ dias: [3], hora: 14, ativa: true })).toEqual({
      tipo: "semanal",
      dias: [3],
      dia_do_mes: null,
      hora: 14,
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
    expect(normalizarRegra({ tipo: "semanal", dias: [7], hora: 9, ativa: true })).toBeNull();
    expect(normalizarRegra({ tipo: "semanal", dias: [1], hora: 24, ativa: true })).toBeNull();
    expect(normalizarRegra({ tipo: "semanal", dias: [1], hora: "9" })).toBeNull();
    expect(normalizarRegra({ tipo: "semanal", dias: [], hora: 9 })).toBeNull();
    expect(normalizarRegra({ tipo: "semanal", dias: [-1, 2.5], hora: 9 })).toBeNull();
  });

  it("só `false` desliga — qualquer outro valor mantém a série ligada", () => {
    // Desligar por acidente é o erro caro: a pessoa deixaria de receber a
    // tarefa sem nunca ter pedido. Por isso o padrão é LIGADA.
    expect(normalizarRegra({ tipo: "diaria", hora: 9 })?.ativa).toBe(true);
    expect(normalizarRegra({ tipo: "diaria", hora: 9, ativa: "false" })?.ativa).toBe(true);
    expect(normalizarRegra({ tipo: "diaria", hora: 9, ativa: false })?.ativa).toBe(false);
  });
});

describe("regraParaGravar", () => {
  it("zera o campo que o tipo não usa — nada de regra ambígua no banco", () => {
    // A tela pode ter dias marcados de uma série antiga quando a pessoa troca
    // para mensal. Gravar os dois faria a próxima depender de qual o leitor
    // olhasse primeiro.
    const mensal: RegraDeRecorrencia = {
      tipo: "mensal",
      dias: [1, 3],
      dia_do_mes: 10,
      hora: 9,
      ativa: true,
    };
    expect(regraParaGravar(mensal)).toEqual({
      tipo: "mensal",
      dias: [],
      dia_do_mes: 10,
      hora: 9,
      ativa: true,
    });

    const diaria: RegraDeRecorrencia = {
      tipo: "diaria",
      dias: [2],
      dia_do_mes: 10,
      hora: 7,
      ativa: true,
    };
    expect(regraParaGravar(diaria)).toEqual({
      tipo: "diaria",
      dias: [],
      dia_do_mes: null,
      hora: 7,
      ativa: true,
    });
  });
});

describe("proximaOcorrencia — a regra de segunda às 9h", () => {
  it("de segunda antes das 9h, a próxima é a MESMA segunda às 9h", () => {
    // 08:00 em Brasília: a ocorrência de hoje ainda não chegou.
    expect(
      proximaOcorrencia(TODA_SEGUNDA_AS_9H, SEGUNDA_8H_BRASILIA, "America/Sao_Paulo")?.toISOString(),
    ).toBe("2026-11-16T12:00:00.000Z");
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
    const tercaESexta: RegraDeRecorrencia = {
      tipo: "semanal",
      dias: [2, 5],
      dia_do_mes: null,
      hora: 9,
      ativa: true,
    };
    const segunda = new Date("2026-11-16T15:00:00.000Z");
    expect(proximaOcorrencia(tercaESexta, segunda, "America/Sao_Paulo")?.toISOString()).toBe(
      "2026-11-17T12:00:00.000Z",
    );
  });

  it("série desligada não tem próxima ocorrência", () => {
    expect(
      proximaOcorrencia(
        { ...TODA_SEGUNDA_AS_9H, ativa: false },
        SEGUNDA_9H_BRASILIA,
        "America/Sao_Paulo",
      ),
    ).toBeNull();
  });
});

describe("proximaOcorrencia — a regra DIÁRIA", () => {
  const todoDiaAs9h: RegraDeRecorrencia = {
    tipo: "diaria",
    dias: [],
    dia_do_mes: null,
    hora: 9,
    ativa: true,
  };

  it("de segunda antes das 9h, a próxima é a própria segunda", () => {
    expect(
      proximaOcorrencia(todoDiaAs9h, SEGUNDA_8H_BRASILIA, "America/Sao_Paulo")?.toISOString(),
    ).toBe("2026-11-16T12:00:00.000Z");
  });

  it("concluída às 9h em ponto, a próxima é o dia SEGUINTE — não a mesma hora de novo", () => {
    expect(
      proximaOcorrencia(todoDiaAs9h, SEGUNDA_9H_BRASILIA, "America/Sao_Paulo")?.toISOString(),
    ).toBe("2026-11-17T12:00:00.000Z");
  });

  it("na virada do mês, o dia seguinte é o dia 1 do mês que vem", () => {
    // 30/11 às 10h em Brasília.
    const fimDeMes = new Date("2026-11-30T13:00:00.000Z");
    expect(proximaOcorrencia(todoDiaAs9h, fimDeMes, "America/Sao_Paulo")?.toISOString()).toBe(
      "2026-12-01T12:00:00.000Z",
    );
  });
});

describe("proximaOcorrencia — a regra MENSAL", () => {
  const todoDia5As9h: RegraDeRecorrencia = {
    tipo: "mensal",
    dias: [],
    dia_do_mes: 5,
    hora: 9,
    ativa: true,
  };

  it("com o dia 5 já passado, a próxima é o dia 5 do mês seguinte", () => {
    // 16/11 às 8h em Brasília.
    expect(
      proximaOcorrencia(todoDia5As9h, SEGUNDA_8H_BRASILIA, "America/Sao_Paulo")?.toISOString(),
    ).toBe("2026-12-05T12:00:00.000Z");
  });

  it("com o dia 5 ainda por vir neste mês, a próxima é a deste mês", () => {
    // 01/11 às 8h em Brasília.
    const inicioDoMes = new Date("2026-11-01T11:00:00.000Z");
    expect(proximaOcorrencia(todoDia5As9h, inicioDoMes, "America/Sao_Paulo")?.toISOString()).toBe(
      "2026-11-05T12:00:00.000Z",
    );
  });

  it("dia 31 em mês de 30 dias cai no ÚLTIMO dia do mês — a série não some", () => {
    const todoDia31: RegraDeRecorrencia = {
      tipo: "mensal",
      dias: [],
      dia_do_mes: 31,
      hora: 9,
      ativa: true,
    };
    // 16/11 às 8h: novembro tem 30 dias, então a ocorrência de novembro é o dia 30.
    expect(
      proximaOcorrencia(todoDia31, SEGUNDA_8H_BRASILIA, "America/Sao_Paulo")?.toISOString(),
    ).toBe("2026-11-30T12:00:00.000Z");
  });

  it("dia 31 em fevereiro cai no dia 28 (2027 não é bissexto)", () => {
    const todoDia31: RegraDeRecorrencia = {
      tipo: "mensal",
      dias: [],
      dia_do_mes: 31,
      hora: 9,
      ativa: true,
    };
    // 01/02/2027 às 8h em Brasília.
    const primeiroDeFevereiro = new Date("2027-02-01T11:00:00.000Z");
    expect(
      proximaOcorrencia(todoDia31, primeiroDeFevereiro, "America/Sao_Paulo")?.toISOString(),
    ).toBe("2027-02-28T12:00:00.000Z");
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
    // 2026-11-17T02:00Z ainda é SEGUNDA (23:00) em Brasília. Uma conta que
    // olhasse o dia em UTC acharia terça e pularia a série por uma semana.
    const agora = new Date("2026-11-17T02:00:00.000Z");
    expect(proximaOcorrencia(TODA_SEGUNDA_AS_9H, agora, "America/Sao_Paulo")?.toISOString()).toBe(
      "2026-11-23T12:00:00.000Z",
    );
  });

  it("o dia do mês também é o do relógio da organização", () => {
    // 05/12 01:00Z = 04/12 22:00 em Brasília: o dia 5 ainda NÃO chegou lá, e a
    // ocorrência é a de dezembro — em UTC já seria 5 e a série escorregaria
    // para janeiro.
    const quaseMeiaNoite = new Date("2026-12-05T01:00:00.000Z");
    const todoDia5: RegraDeRecorrencia = {
      tipo: "mensal",
      dias: [],
      dia_do_mes: 5,
      hora: 9,
      ativa: true,
    };
    expect(proximaOcorrencia(todoDia5, quaseMeiaNoite, "America/Sao_Paulo")?.toISOString()).toBe(
      "2026-12-05T12:00:00.000Z",
    );
  });
});
