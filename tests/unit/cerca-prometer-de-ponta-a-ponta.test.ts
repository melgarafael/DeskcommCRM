import { describe, expect, it } from "vitest";

import {
  casePromiseGate,
  type GateContext,
} from "@/lib/agent-engine/guardrails/before-send";

/**
 * CERCA C — nenhuma promessa ao cliente sai sem destino.
 *
 * ═══ O defeito, medido em produção (2026-09-16) ═════════════════════════════
 *
 * O agente enviou: *"Vou encaminhar as informações do site imobiliário para
 * análise e te retorno com a proposta."* O cliente saiu da conversa esperando um
 * orçamento.
 *
 * O sistema produziu: **zero** casos humanos, **zero** follow-ups, **zero**
 * avisos na Central. E o funil ainda moveu o negócio para "Proposta enviada" por
 * causa da promessa.
 *
 * Existe uma trava para exatamente isso (`casePromiseGate`, código
 * `case_promise_without_case`). Ela disparou **uma vez**. O desenho é: 1º veto
 * ensina, 2º veto o sistema abre um caso mínimo sozinho e libera. Houve **um**
 * veto e **zero** casos — a segunda formulação **passou**, e o fail-safe nunca
 * foi alcançado.
 *
 * Causa: `detectHumanPromise` é **léxico** — exige palavra de alvo humano
 * (equipe, time, setor, responsável, especialista, atendente, gerente…) colada
 * ao verbo. Um objeto no meio ("as informações") já quebra o padrão. **A trava
 * não é uma trava: é um filtro de formulação, e ela ensina o modelo a reformular
 * até passar.**
 *
 * ═══ A CERCA MEDE DOIS MUNDOS, E O SEGUNDO NÃO É UM DEFEITO ═════════════════
 *
 * O conserto da Tarefa 7 fez o gate ler DOIS sinais, em OU: o léxico
 * (`detectHumanPromise`) e o semântico (`ctx.semanticPromise?.prometeuRetornoHumano`).
 * Mas a camada semântica é uma escolha do CLIENTE, não uma verdade dura do
 * código:
 *
 *  - `PROMISE_SEMANTIC_ENABLED` tem `.default('true')` em `lib/agent-engine/env.ts`,
 *    então a organização nasce COM a camada ligada;
 *  - e a organização pode DESLIGÁ-LA por linha em `org_guardrail_layers` (regra
 *    `escolhaDaOrg ?? padraoDoAmbiente`, em `lib/agent-engine/guardrails/camadas-da-org.ts`).
 *
 * São dois mundos, e a cerca mede os DOIS porque o segundo é um estado que uma
 * pessoa pode causar clicando numa tela. O caso **1A** mede o caminho normal
 * (camada ligada): as SETE frases são vetadas. O caso **1B** mede o caminho da
 * organização que desligou a camada para economizar chamada de modelo: só as
 * DUAS que o léxico pega continuam vetadas — e as outras CINCO voltam a vazar.
 * Não é um defeito a consertar; é a verdade sobre o produto, escrita:
 * **desligar a camada REABRE o vazamento das cinco frases**, e quem desliga
 * precisa saber disso.
 */

/**
 * Contexto mínimo aceito pelo gate, SEM a camada semântica. É o mundo do 1B —
 * a organização que desligou a camada em `org_guardrail_layers`.
 */
function comCtx(body: string, extra: Partial<GateContext> = {}) {
  return {
    body,
    casesEnabled: true,
    hasOpenCase: false,
    openedCaseThisTurn: false,
    ...extra,
  } as never;
}

/**
 * O mundo do 1A — a organização que mantém a camada semântica ligada (o padrão
 * de `PROMISE_SEMANTIC_ENABLED`). O `prometeuRetornoHumano: true` é o sinal que
 * a camada acrescenta.
 *
 * `isPromise: false` de propósito: as SETE frases NÃO são promessa comercial
 * (não oferecem grátis, desconto nem prazo de entrega) — é a pergunta NOVA que
 * as pega, e montar o fixture com `isPromise: true` mediria o gate errado.
 */
function comCtxSemantico(body: string, extra: Partial<GateContext> = {}) {
  return {
    body,
    casesEnabled: true,
    hasOpenCase: false,
    openedCaseThisTurn: false,
    semanticPromise: {
      isPromise: false,
      suspectPhrase: null,
      prometeuRetornoHumano: true,
    },
    ...extra,
  } as never;
}

const frasesQuePrometemRetorno = [
  "Vou encaminhar as informações do site imobiliário para análise e te retorno com a proposta.",
  "Vou encaminhar as informações para a equipe e te retorno com a proposta.",
  "Vou encaminhar para o responsável e te retorno.",
  "Vou analisar e te retorno com a proposta.",
  "Te retorno com a proposta em breve.",
  "Vou levar isso para avaliação interna e te dou um retorno.",
  "Vou passar para o setor comercial montar o orçamento.",
];

/**
 * Os índices que o detector LÉXICO pega sozinho — as outras CINCO vazam sem a
 * camada semântica. Medido em 2026-09-16: (2) "para o responsável" e (6) "para o
 * setor comercial" nomeiam o alvo humano colado ao verbo e casam com o padrão
 * antigo; as demais quebram o padrão com um objeto no meio ou dispensam o alvo.
 */
const INDICES_QUE_O_LEXICO_PEGA = new Set([2, 6]);

const falasInocentes = [
  "Bom dia! Como posso ajudar?",
  "Nosso horário é de segunda a sexta, das 8h às 18h.",
  "Qual prazo você julga ideal?",
  "Consigo te oferecer quinta às 14h ou sexta às 10h.",
];

describe("cerca prometer de ponta a ponta", () => {
  it.each(frasesQuePrometemRetorno)(
    "COM a camada semântica, VETA sem caso aberto: %s",
    (frase) => {
      // O caminho normal: `PROMISE_SEMANTIC_ENABLED` nasce com default `'true'`,
      // então a organização que não mexeu em `org_guardrail_layers` está aqui.
      // O sinal semântico pega as SETE — inclusive as CINCO que o léxico sozinho
      // deixa passar. É o conserto do defeito medido.
      const verdict = casePromiseGate.evaluate(comCtxSemantico(frase));
      expect(verdict.pass).toBe(false);
      if (!verdict.pass) {
        expect(verdict.code).toBe("case_promise_without_case");
      }
    },
  );

  it.each(frasesQuePrometemRetorno.map((frase, i) => [i, frase] as const))(
    "SEM a camada semântica o vazamento VOLTA — só o léxico veta (índice %i): %s",
    (i, frase) => {
      // Este caso NÃO é um defeito a consertar — é a verdade sobre o produto,
      // escrita. A camada semântica é opcional por organização
      // (`org_guardrail_layers`, regra `escolhaDaOrg ?? padraoDoAmbiente`), e
      // quem a desliga para economizar chamada de modelo precisa saber o que
      // acabou de desligar: das SETE frases, só as DUAS que nomeiam o alvo humano
      // colado ao verbo continuam vetadas. As outras CINCO vazam.
      //
      // Se o produto um dia decidir que desligar a camada é proibido, este caso
      // fica vermelho — e é esse o sinal, não um defeito.
      const verdict = casePromiseGate.evaluate(comCtx(frase));
      if (INDICES_QUE_O_LEXICO_PEGA.has(i)) {
        expect(verdict.pass, `a frase ${i} deveria ser vetada pelo léxico`).toBe(false);
        if (!verdict.pass) {
          expect(verdict.code).toBe("case_promise_without_case");
        }
      } else {
        expect(
          verdict.pass,
          `a frase ${i} vaza sem a camada semântica — reabrir isto exige decisão de produto`,
        ).toBe(true);
      }
    },
  );

  it.each(falasInocentes)(
    "CONTROLE — não veta fala inocente: %s",
    (frase) => {
      const verdict = casePromiseGate.evaluate(comCtx(frase));
      expect(verdict.pass).toBe(true);
    },
  );

  it.each(frasesQuePrometemRetorno)(
    "com caso já aberto, nenhuma é vetada: %s",
    (frase) => {
      const verdict = casePromiseGate.evaluate(comCtx(frase, { hasOpenCase: true }));
      expect(verdict.pass).toBe(true);
    },
  );

  it("o campo semântico é OPCIONAL — sem ele, o gate cai no léxico", () => {
    // Este caso existe para preservar a restrição congelada: se `semanticPromise`
    // virar obrigatório no `GateContext`, os 6 casos de
    // tests/invariants/case-guardrail.test.ts quebram — e o hook de git bloqueia
    // o commit que os consertaria. A ausência do campo precisa continuar
    // significando "não há sinal semântico", exatamente o comportamento atual.
    const fraseQueOLexicoPega = frasesQuePrometemRetorno[2]!;
    const fraseQueOLexicoNaoPega = frasesQuePrometemRetorno[0]!;

    const verdictVeta = casePromiseGate.evaluate(comCtx(fraseQueOLexicoPega));
    expect(verdictVeta.pass).toBe(false);

    const verdictPassa = casePromiseGate.evaluate(comCtx(fraseQueOLexicoNaoPega));
    expect(verdictPassa.pass).toBe(true);
  });
});
