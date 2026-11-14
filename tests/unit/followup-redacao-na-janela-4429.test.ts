/**
 * A ROTAÇÃO DA REDAÇÃO OLHA A JANELA DE REPETIÇÃO (#4429 — segunda metade).
 *
 * ─── O que ficou faltando na primeira metade ───────────────────────────────
 *
 * A #4446 deu ao passo de mensagem mais de uma redação e uma rotação
 * determinística (`hash(contato) + envios`, módulo n). O que ela declarou, no
 * próprio cabeçalho do módulo, que NÃO fazia: escolher a redação com a JANELA em
 * vista — a lista das últimas 20 cópias do NÚMERO (`outbound_copies`), a mesma
 * que o gate `spinning` confere — e reagendar quando nenhuma passa.
 *
 * Medido antes desta fatia (contagem, não cronômetro; Jaccard ≥ 0,8,
 * `repetitionThreshold` 2, janela 20): uma redação → 2 envios; três trocando só
 * a saudação (Jaccard 0,79–0,86) → 3; três realmente distintas (0,08–0,13) → 6.
 * Ou seja: a rotação sozinha não muda o número de envios que a trava barra — ela
 * só muda QUANTAS redações são tentadas antes de bater na parede.
 *
 * ─── O contrato desta fatia ────────────────────────────────────────────────
 *
 * 1. a ordem da vez continua sendo a da rotação (`redacoesNaOrdemDaVez`): a
 *    preferida primeiro, e as seguintes na volta;
 * 2. entre as redações, vence a de MENOR colisão com a janela — e o empate fica
 *    com a preferida da rotação, então sem pressão de janela o texto que sai é
 *    exatamente o de hoje;
 * 3. `null` quando TODAS colidem: aí não é "pule o passo", é "adie" — quem
 *    decide o adiamento é o caminho de envio, e é o que o caso vizinho
 *    (`outside_window`) já faz.
 */
import { describe, expect, it } from "vitest";

import {
  redacaoQuePassaNaJanela,
  redacoesDoPasso,
  redacoesNaOrdemDaVez,
  redacaoDaVez,
} from "@/lib/followup/variacoes-do-passo";
import { SPINNING_DEFAULTS, type SpinningKnobs } from "@/lib/agent-engine/spinning/defaults";
import { hashNormalized, normalizeCopy } from "@/lib/agent-engine/spinning/engine";

const KNOBS: SpinningKnobs = { ...SPINNING_DEFAULTS };
const CONTATO = "contato-1";

/** A janela como o store a entrega: normalizada + hash, mais recente primeiro. */
function janela(...textos: string[]) {
  return textos.map((texto) => {
    const normalizedText = normalizeCopy(texto);
    return { normalizedText, normalizedHash: hashNormalized(normalizedText) };
  });
}

const A = "Oi Ana, separamos uma condição especial para você e para a sua equipe.";
const B = "Ana, o time liberou uma condição especial e eu queria te contar hoje.";
const C = "Passando para falar da condição que abrimos: ela vale até sexta, Ana.";

describe("redacoesNaOrdemDaVez", () => {
  it("a preferida da rotação vem primeiro, e a volta não repete redação", () => {
    const redacoes = [A, B, C];
    for (let enviados = 0; enviados < 6; enviados++) {
      const ordem = redacoesNaOrdemDaVez(redacoes, CONTATO, enviados);
      expect(ordem[0]).toBe(redacaoDaVez(redacoes, CONTATO, enviados));
      expect(new Set(ordem).size).toBe(3);
      expect(ordem).toHaveLength(3);
    }
  });

  it("passo de redação única devolve a mesma lista de um", () => {
    expect(redacoesNaOrdemDaVez(["única"], CONTATO, 7)).toEqual(["única"]);
  });

  it("é determinística: o mesmo estado devolve a mesma ordem", () => {
    expect(redacoesNaOrdemDaVez([A, B, C], CONTATO, 2)).toEqual(redacoesNaOrdemDaVez([A, B, C], CONTATO, 2));
  });
});

describe("redacaoQuePassaNaJanela", () => {
  it("⭐ janela vazia: sai a preferida da rotação — byte a byte o de hoje", () => {
    const ordem = redacoesNaOrdemDaVez([A, B, C], CONTATO, 0);
    expect(redacaoQuePassaNaJanela(ordem, [], KNOBS)).toBe(ordem[0]);
  });

  it("⭐ escolhe a de MENOR colisão — e não a primeira que ainda passa", () => {
    // A e B estão na janela UMA vez cada (colisão 1, abaixo do limiar 2 — as
    // duas "passariam"); C não está. "A primeira que passa" devolveria A ou B e
    // repetiria o texto que o número acabou de mandar; a régua da issue é a
    // MENOR colisão, então a resposta tem de ser C, seja qual for a ordem.
    const ordem = redacoesNaOrdemDaVez([A, B, C], CONTATO, 0);
    expect(redacaoQuePassaNaJanela(ordem, janela(A, B), KNOBS)).toBe(C);
  });

  it("⭐ quando TODAS colidem devolve null — é o sinal para ADIAR, não para pular", () => {
    expect(redacaoQuePassaNaJanela([A, B, C], janela(A, A, B, B, C, C), KNOBS)).toBeNull();
  });

  it("texto curto é isento pela allowlist da própria trava e passa", () => {
    const curtinho = "ok";
    expect(redacaoQuePassaNaJanela([curtinho], janela(curtinho, curtinho, curtinho), KNOBS)).toBe(curtinho);
  });

  it("empate de colisão fica com a preferida da rotação", () => {
    // Sem nada na janela, A e B empatam em zero colisões: sai a primeira.
    const ordem = redacoesNaOrdemDaVez([A, B], CONTATO, 3);
    expect(redacaoQuePassaNaJanela(ordem, [], KNOBS)).toBe(ordem[0]);
  });
});

describe("o número de envios que a janela aceita (a conta da issue)", () => {
  /**
   * A contagem que sustenta a issue, reproduzida aqui sobre a MESMA janela que o
   * gate usa: a cada envio a janela recebe a redação que saiu e o gate reprova a
   * próxima candidata quando ela colide duas vezes. Antes da fatia (rotação
   * cega) o fluxo era: 1 redação → 2 envios; 3 trocando só a saudação → 3; 3
   * distintas → 6.
   */
  function enviosAceitos(redacoes: string[], limite = 8): string[] {
    const aceitas: string[] = [];
    let janelaAtual = janela();
    for (let volta = 0; volta < limite; volta++) {
      const ordem = redacoesNaOrdemDaVez(redacoes, `contato-${volta}`, 0);
      const escolhida = redacaoQuePassaNaJanela(ordem, janelaAtual, KNOBS);
      if (escolhida === null) break;
      aceitas.push(escolhida);
      janelaAtual = [...janela(escolhida), ...janelaAtual];
    }
    return aceitas;
  }

  it("três redações realmente distintas passam MAIS que três trocando só a saudação", () => {
    const saudacao = [
      "Oi Ana, separamos uma condição especial para você e para a sua equipe hoje.",
      "Olá Ana, separamos uma condição especial para você e para a sua equipe hoje.",
      "E aí Ana, separamos uma condição especial para você e para a sua equipe hoje.",
    ];
    const aceitasComSaudacao = enviosAceitos(saudacao);
    const aceitasDistintas = enviosAceitos([A, B, C]);

    // A troca de saudação não engana a janela: ela para antes.
    expect(aceitasComSaudacao.length).toBeLessThan(aceitasDistintas.length);
    expect(aceitasDistintas.length).toBeGreaterThanOrEqual(3);
  });

  it("redação única continua parando na trava — a janela não inventa texto", () => {
    expect(enviosAceitos([A]).length).toBeLessThanOrEqual(2);
  });
});

describe("redacoesDoPasso segue a fonte das redações", () => {
  it("body primeiro, variações depois", () => {
    expect(redacoesDoPasso({ body: A, variacoes: [B, C] })).toEqual([A, B, C]);
  });
});
