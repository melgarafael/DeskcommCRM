/**
 * A TELA NÃO PODE VENDER PROTEÇÃO QUE NÃO RODA — NEM ESCONDER A QUE RODA.
 *
 * `lib/ai/guardrails/lista-de-conferencia.ts` duplica, em linguagem de gente, a
 * lista que `BEFORE_SEND_GATES` define em runtime. A duplicação é obrigatória: o
 * módulo da cadeia importa `pg`, os stores de pacing/spinning e o adaptador de
 * canal, e trazê-lo para um componente arrastaria o motor inteiro para o bundle
 * do browser.
 *
 * Toda lista de apresentação que espelha uma constante de runtime **sem teste de
 * casamento** apodrece na direção que ninguém olha. Aqui as duas direções doem de
 * jeitos diferentes:
 *
 * - conferência na cadeia e FORA da lista → a tela é cega: o dono do negócio não
 *   sabe que aquilo é conferido, e quando barrar não vai entender o que barrou;
 * - conferência na lista e FORA da cadeia → a tela MENTE: promete uma proteção
 *   que não acontece, que é pior que não prometer nada.
 *
 * O cabeçalho do próprio `before-send.ts` registra que esta cadeia já teve um
 * guarda prometido e inexistente por meses. Este é o guarda.
 *
 * Um teste pode importar `pg` à vontade — ele roda em Node, não no browser. É
 * justamente por isso que a verificação cabe aqui e não no componente.
 */
import { describe, expect, it } from "vitest";

import { BEFORE_SEND_GATES } from "@/lib/agent-engine/guardrails/before-send";
import { CAMADAS_SEMANTICAS } from "@/lib/agent-engine/guardrails/camadas-da-org";
import {
  CONFERENCIAS_DE_SAIDA,
  CONFERENCIA_DE_ENTRADA,
} from "@/lib/ai/guardrails/lista-de-conferencia";

const naCadeia = BEFORE_SEND_GATES.map((g) => g.name);
const naTela = CONFERENCIAS_DE_SAIDA.map((c) => c.nome);

describe("a lista da tela casa com a cadeia que roda", () => {
  it("as duas listas existem e não estão vazias — controle positivo", () => {
    // Sem isto, um import que passasse a resolver para `undefined` deixaria as
    // comparações abaixo comparando dois vazios: verde por não medir nada.
    expect(naCadeia.length).toBeGreaterThan(5);
    expect(naTela.length).toBe(naCadeia.length);
  });

  it("nenhuma conferência que RODA fica fora da tela", () => {
    const invisiveis = naCadeia.filter((n) => !naTela.includes(n));
    expect(
      invisiveis,
      "estas conferências acontecem e o dono do negócio não sabe — quando barrarem, " +
        "ele não vai entender o que barrou.\n",
    ).toEqual([]);
  });

  it("nenhuma conferência da tela deixa de RODAR", () => {
    const inventadas = naTela.filter((n) => !naCadeia.includes(n));
    expect(
      inventadas,
      "a tela promete proteção que a cadeia não faz. Prometer e não fazer é pior " +
        "que não prometer.\n",
    ).toEqual([]);
  });

  it("a ORDEM é a mesma — ela é informação, não estética", () => {
    // A primeira conferência que veta interrompe a cadeia. Mostrar fora de ordem
    // faria alguém procurar por que a mensagem barrada no "parar" não foi
    // avaliada pelas seguintes.
    expect(naTela).toEqual([...naCadeia]);
  });

  it("a conferência de ENTRADA fica fora da lista de saída, de propósito", () => {
    // Ela roda sobre o que o cliente escreveu, antes da cadeia. Misturá-la faria
    // a ordem acima deixar de ser verdade.
    expect(naCadeia).not.toContain(CONFERENCIA_DE_ENTRADA.nome);
  });

  it("cada conferência diz o que protege, e as sem escolha dizem por quê", () => {
    for (const c of [...CONFERENCIAS_DE_SAIDA, CONFERENCIA_DE_ENTRADA]) {
      expect(c.rotulo.length, `${c.nome} sem rótulo`).toBeGreaterThan(10);
      expect(c.oQueProtege.length, `${c.nome} não diz o que protege`).toBeGreaterThan(30);
      if (c.escolha === null) {
        // Sem esta linha, o que aparece na tela é uma proibição sem razão — e
        // proibição sem razão é o que faz alguém procurar como contornar.
        expect(
          c.porQueNaoSeDesliga.length,
          `${c.nome} não pode ser desligada e não diz por quê`,
        ).toBeGreaterThan(30);
      } else {
        expect(c.escolha.custo, `${c.nome} é configurável e não diz o custo`).toMatch(
          c.escolha.consultaModelo ? /consulta/i : /não custa/i,
        );
      }
    }
  });

  it("as camadas configuráveis apontam para chaves que a tabela conhece", () => {
    // SÃO DOIS VOCABULÁRIOS e eles não coincidem: aqui o nome é o do gate na
    // cadeia (`semantic_promise`), na tabela é o da camada (`promessa_semantica`).
    // Casar um pelo outro por semelhança de nome fez a tela não encontrar o
    // estado e mostrar "carregando…" para sempre — pego pelo teste de componente
    // ao escrever isto. O vínculo é explícito no campo `camada`, e este caso é o
    // que impede a próxima divergência.
    const declaradas = [...CONFERENCIAS_DE_SAIDA, CONFERENCIA_DE_ENTRADA]
      .map((c) => c.camada)
      .filter((c): c is NonNullable<typeof c> => c !== null);

    expect(new Set(declaradas)).toEqual(new Set(CAMADAS_SEMANTICAS));

    // E o inverso: conferência COM escolha tem de declarar a camada, senão o
    // interruptor não teria o que gravar.
    for (const c of [...CONFERENCIAS_DE_SAIDA, CONFERENCIA_DE_ENTRADA]) {
      if (c.escolha !== null) {
        expect(c.camada, `${c.nome} é configurável e não diz qual camada grava`).not.toBeNull();
      } else {
        expect(c.camada, `${c.nome} não é escolha e mesmo assim aponta uma camada`).toBeNull();
      }
    }
  });

  it("nenhum texto da tela carrega vocabulário interno", () => {
    // Quem lê é dono de clínica. Repetir na tela de configuração o vocabulário
    // que a conferência `internal_vocabulary` existe para barrar seria irônico.
    for (const c of [...CONFERENCIAS_DE_SAIDA, CONFERENCIA_DE_ENTRADA]) {
      const texto = `${c.rotulo} ${c.oQueProtege} ${c.porQueNaoSeDesliga}`.toLowerCase();
      for (const jargao of ["gate", "before_send", "payload", "veto", "runtime", "_id"]) {
        expect(texto, `jargão "${jargao}" no texto de ${c.nome}`).not.toContain(jargao);
      }
    }
  });
});
