import { describe, expect, it } from "vitest";

import { casePromiseGate, type GateContext } from "@/lib/agent-engine/guardrails/before-send";
import { deveAbrirCasoDoFailsafe } from "@/lib/agent-engine/guardrails/failsafe-do-caso";
import {
  detectHumanHandoffPromise,
  detectHumanPromise,
} from "@/lib/agent-engine/guardrails/human-promise";
import { detectarPromessaDeRetornoDoAssistente } from "@/lib/agent-engine/guardrails/retorno-do-assistente";
import { agentConfigPatchSchema } from "@/lib/ai/guardrails-schema";
import { montarResumoDoCaso } from "@/lib/escalacao/resumo-do-caso";
import { PACING_DEFAULTS } from "@/lib/agent-engine/pacing/defaults";
import { SPINNING_DEFAULTS } from "@/lib/agent-engine/spinning/defaults";

/**
 * #3816 — OS SEIS PONTOS DO CR DO MANTENEDOR, UM `describe` POR PONTO.
 *
 * O PR #3816 fechou o #3725 (o fail-safe abria caso humano para quem só tinha
 * respondido "Não"). A revisão de 31/10 e o adendo de 02/11 aprovaram a direção
 * e pediram seis ajustes, todos decididos pelo Marcos no comentário
 * 6590316676 — este arquivo é a régua deles, item por item:
 *
 *   1. `soRetornoDeHumano` é destino válido de follow-up nos DOIS lugares: na
 *      condição do ramo do retorno (que roda com casos LIGADOS e DESLIGADOS) e
 *      no `return pass` por `agendadoNesteTurno`. Sem isso a razão nova manda o
 *      modelo chamar `schedule_followup`, ele chama, e o gate veta igual.
 *   2. A régua do fail-safe é a da issue: só deixa de abrir caso quando NENHUMA
 *      mensagem do cliente na demanda atual tem sinal de pessoa. Uma só basta.
 *   3. `atender`, `assumir` e `entrar em contato` são o vocabulário REAL do
 *      operador e contam como sinal de pessoa do lado da AÇÃO (é passagem, não
 *      promessa de retorno).
 *   4. O resumo leva a fala MAIS RECENTE do cliente primeiro e o motivo da
 *      abertura em seguida — o corte de 160 caracteres do aviso da equipe não
 *      pode mais comer justamente a última fala. O extrato completo continua no
 *      mesmo campo, para a Central.
 *   5. A frase própria do aviso entra no schema do PATCH (hoje ela é DESCARTADA
 *      e só se configura direto no banco) e na tela; a tela tem teste próprio,
 *      ao lado do componente.
 *   6. O caso novo do #3856: "Nossa equipe vai te responder em breve." cai no
 *      `if (!ctx.casesEnabled) return { pass: true }` e sai SEM nada agendado.
 *      Conserto em duas partes — padrão que case o texto real em
 *      `retorno-do-assistente.ts` E o ramo do retorno aceitando a família de
 *      retorno do léxico humano. Medido nos DOIS estados de `casesEnabled`.
 */

function baseCtx(overrides: Partial<GateContext> = {}): GateContext {
  return {
    now: new Date("2026-11-02T12:00:00Z"),
    body: "",
    optedOut: false,
    provider: "waha",
    pacing: {
      knobs: PACING_DEFAULTS,
      state: { lastSentAt: null, sentToday: 0, numberActivatedAt: null },
      crmDailyLimit: null,
    },
    spinning: { knobs: SPINNING_DEFAULTS, window: [] },
    promise: { table: null },
    semanticPromise: null,
    disclosure: { template: null, isFirstOutbound: false, mode: "inject" },
    lgpd: null,
    casesEnabled: false,
    hasOpenCase: false,
    openedCaseThisTurn: false,
    ...overrides,
  };
}

/** A frase que o mantenedor mediu vazando com os casos DESLIGADOS. */
const FRASE_DA_EQUIPE = "Nossa equipe vai te responder em breve.";

/** A mesma família, com o marcador de tempo na forma que o léxico já conhece. */
const RETOMADA_DO_NAO = "Sem problema! Nossa equipe vai te responder outro dia.";

const CONVERSA_DO_NAO = [
  { direction: "outbound", body: "Tem algum dia ou período melhor para o contato?" },
  { direction: "inbound", body: "Não" },
] as const;

describe("ponto 1 — `soRetornoDeHumano` é destino de follow-up nos dois lugares", () => {
  it("(1a) RAMO DO RETORNO: com casos DESLIGADOS e sem retorno agendado, veta e ensina o follow-up", () => {
    const v = casePromiseGate.evaluate(
      baseCtx({
        body: FRASE_DA_EQUIPE,
        casesEnabled: false,
        followup: { disponivel: true, agendadoNesteTurno: false },
      }),
    );
    expect(v).toMatchObject({ pass: false, code: "followup_promise_without_followup" });
  });

  it("(1a-controle) RAMO DO RETORNO: com casos DESLIGADOS e o retorno AGENDADO, passa", () => {
    const v = casePromiseGate.evaluate(
      baseCtx({
        body: FRASE_DA_EQUIPE,
        casesEnabled: false,
        followup: { disponivel: true, agendadoNesteTurno: true },
      }),
    );
    expect(v.pass).toBe(true);
  });

  it("(1b) RETURN PASS POR `agendadoNesteTurno`: com casos LIGADOS, o retorno da equipe já marcado passa", () => {
    const v = casePromiseGate.evaluate(
      baseCtx({
        body: RETOMADA_DO_NAO,
        casesEnabled: true,
        followup: { disponivel: true, agendadoNesteTurno: true },
      }),
    );
    expect(v).toEqual({ pass: true });
  });

  it("(1b-controle) o mesmo retorno SEM estar agendado continua vetado (a invariante não afrouxou)", () => {
    const v = casePromiseGate.evaluate(
      baseCtx({
        body: RETOMADA_DO_NAO,
        casesEnabled: true,
        followup: { disponivel: true, agendadoNesteTurno: false },
      }),
    );
    expect(v).toMatchObject({ pass: false, code: "case_promise_without_case" });
  });

  it("(1c) a família de AÇÃO não ganhou a passagem: 'Já encaminhei para a equipe' segue exigindo CASO", () => {
    const v = casePromiseGate.evaluate(
      baseCtx({
        body: "Já encaminhei para a equipe.",
        casesEnabled: true,
        followup: { disponivel: true, agendadoNesteTurno: true },
      }),
    );
    expect(v).toMatchObject({ pass: false, code: "case_promise_without_case" });
  });
});

describe("ponto 2 — a régua do fail-safe: uma mensagem com sinal de pessoa basta", () => {
  const CORPO_DE_RETOMADA = RETOMADA_DO_NAO;

  it("(2a) NENHUMA mensagem do cliente com sinal de pessoa: NÃO abre", () => {
    for (const conversa of [
      CONVERSA_DO_NAO,
      [
        { direction: "outbound", body: "Qual seu nome?" },
        { direction: "inbound", body: "Maria" },
      ],
      [
        { direction: "outbound", body: "Posso mandar o catálogo?" },
        { direction: "inbound", body: "Pode, obrigado" },
      ],
    ]) {
      expect(
        deveAbrirCasoDoFailsafe({ mensagens: conversa, corpo: CORPO_DE_RETOMADA }),
        JSON.stringify(conversa),
      ).toBe(false);
    }
  });

  it("(2b) UMA mensagem com sinal de pessoa (as 22 de 24 que o mantenedor mediu) ABRE", () => {
    const pedidos = [
      "preciso de um humano",
      "quero falar com o gerente",
      "atendente",
      "pessoa real",
      "vou no procon se ninguém me atender",
      "me chama no whatsapp de alguém do time",
      "tem como falar com o supervisor?",
    ];
    for (const pedido of pedidos) {
      expect(
        deveAbrirCasoDoFailsafe({
          mensagens: [
            { direction: "outbound", body: "Tem algum dia ou período melhor para o contato?" },
            { direction: "inbound", body: pedido },
          ],
          corpo: CORPO_DE_RETOMADA,
        }),
        pedido,
      ).toBe(true);
    }
  });

  it("(2c) o sinal pode estar em QUALQUER mensagem da demanda, não só na última", () => {
    expect(
      deveAbrirCasoDoFailsafe({
        mensagens: [
          { direction: "inbound", body: "quero falar com um atendente de verdade" },
          { direction: "outbound", body: "Claro! Antes, me conta o que você precisa." },
          { direction: "inbound", body: "Não" },
        ],
        corpo: CORPO_DE_RETOMADA,
      }),
    ).toBe(true);
  });

  it("(2d) o sinal só vale vindo do CLIENTE — a fala da IA não abre caso sozinha", () => {
    expect(
      deveAbrirCasoDoFailsafe({
        mensagens: [
          { direction: "outbound", body: "Vou pedir para um atendente humano te ligar." },
          { direction: "inbound", body: "Ok" },
        ],
        corpo: CORPO_DE_RETOMADA,
      }),
    ).toBe(false);
  });

  it("(2e) promessa explícita de AÇÃO da IA continua abrindo caso mesmo sem pedido", () => {
    expect(
      deveAbrirCasoDoFailsafe({
        mensagens: CONVERSA_DO_NAO,
        corpo: "Já encaminhei para a equipe.",
      }),
    ).toBe(true);
  });
});

describe("ponto 3 — `atender`, `assumir` e `entrar em contato` são sinal de pessoa (AÇÃO)", () => {
  it.each([
    "Uma pessoa da equipe vai te atender agora.",
    "Nosso time vai assumir a partir daqui.",
    "A equipe vai entrar em contato com você.",
    "O responsável vai te atender em instantes.",
  ])("%j conta como passagem (família da AÇÃO)", (frase) => {
    expect(detectHumanHandoffPromise(frase)).toBe(true);
    // …e continua sendo PROMESSA para o detector amplo (o gate segue vetando).
    expect(detectHumanPromise(frase)).toBe(true);
  });

  it("a família do RETORNO não foi roubada: 'vai te responder outro dia' não vira passagem", () => {
    expect(detectHumanHandoffPromise(RETOMADA_DO_NAO)).toBe(false);
    expect(detectHumanHandoffPromise(FRASE_DA_EQUIPE)).toBe(false);
  });
});

describe("ponto 4 — o resumo abre pela ÚLTIMA fala do cliente, com o motivo", () => {
  const MOTIVO = "a IA prometeu humano sem caso aberto (fail-safe do guardrail)";
  const CONVERSA = [
    { direction: "outbound", body: "Oi, bom dia! Sou a assistente virtual da Acme." },
    { direction: "inbound", body: "Bom dia" },
    { direction: "outbound", body: "Tem algum dia ou período melhor para o contato?" },
    { direction: "inbound", body: "Não" },
    { direction: "inbound", body: "Pode ser quinta às 10h? Preciso resolver isso essa semana." },
  ] as const;

  it("(4a) os 160 primeiros caracteres — o corte do aviso da equipe — trazem a última fala", () => {
    const resumo = montarResumoDoCaso(CONVERSA, MOTIVO);
    expect(resumo.slice(0, 160)).toContain("Pode ser quinta às 10h?");
    expect(resumo.slice(0, 160)).not.toContain("Sou a assistente virtual");
  });

  it("(4b) o motivo da abertura também cabe no corte", () => {
    const resumo = montarResumoDoCaso(CONVERSA, MOTIVO);
    expect(resumo.slice(0, 160)).toContain("Motivo");
    expect(resumo.slice(0, 160)).toContain("prometeu humano");
  });

  it("(4c) o extrato completo continua no mesmo campo — é ele que a Central mostra", () => {
    const resumo = montarResumoDoCaso(CONVERSA, MOTIVO);
    expect(resumo).toContain("Atendimento: Oi, bom dia! Sou a assistente virtual da Acme.");
    expect(resumo).toContain("Cliente: Bom dia");
    expect(resumo).toContain("Atendimento: Tem algum dia ou período melhor para o contato?");
    expect(resumo).toContain(`Motivo: ${MOTIVO}`);
  });

  it("(4d) sem fala do cliente o resumo não inventa cabeça: só o motivo", () => {
    const resumo = montarResumoDoCaso(
      [{ direction: "outbound", body: "Falamos em breve." }],
      MOTIVO,
    );
    expect(resumo.startsWith("Motivo:")).toBe(true);
  });
});

describe("ponto 5 — a frase própria entra no SCHEMA do PATCH (a tela tem teste próprio)", () => {
  it("o PATCH de agente aceita e PRESERVA `aviso_de_handoff`", () => {
    const patch = agentConfigPatchSchema.parse({
      aviso_de_handoff: "Já chamei o time, pode ficar tranquilo!",
    });
    expect(patch).toEqual({ aviso_de_handoff: "Já chamei o time, pode ficar tranquilo!" });
  });

  it("limpar a frase é possível (`null`) e config vazio não inventa chave", () => {
    expect(agentConfigPatchSchema.parse({ aviso_de_handoff: null })).toEqual({
      aviso_de_handoff: null,
    });
    expect(agentConfigPatchSchema.parse({})).toEqual({});
  });
});

describe("ponto 6 — o caso novo do #3856: a frase da equipe com `casesEnabled=false`", () => {
  it("(6a) o padrão do detector de retorno casa o TEXTO REAL", () => {
    for (const frase of [
      FRASE_DA_EQUIPE,
      "A equipe vai te responder em breve.",
      "Nosso time vai te dar um retorno em breve.",
      "Nossa equipe vai te responder ainda hoje.",
    ]) {
      expect(detectarPromessaDeRetornoDoAssistente(frase), frase).toBe(true);
    }
  });

  it("(6b) casos DESLIGADOS, sem follow-up agendado: o texto não escapa, é vetado com ensino", () => {
    const v = casePromiseGate.evaluate(
      baseCtx({
        body: FRASE_DA_EQUIPE,
        casesEnabled: false,
        followup: { disponivel: true, agendadoNesteTurno: false },
      }),
    );
    expect(v).toMatchObject({ pass: false, code: "followup_promise_without_followup" });
  });

  it("(6c) casos DESLIGADOS, follow-up AGENDADO: a frase passa (o destino existe)", () => {
    const v = casePromiseGate.evaluate(
      baseCtx({
        body: FRASE_DA_EQUIPE,
        casesEnabled: false,
        followup: { disponivel: true, agendadoNesteTurno: true },
      }),
    );
    expect(v.pass).toBe(true);
  });

  it("(6d) casos LIGADOS: a mesma frase já era vetada e pede caso/follow-up (assimetria fechada)", () => {
    const v = casePromiseGate.evaluate(
      baseCtx({
        body: FRASE_DA_EQUIPE,
        casesEnabled: true,
        followup: { disponivel: true, agendadoNesteTurno: false },
      }),
    );
    expect(v).toMatchObject({ pass: false, code: "case_promise_without_case" });
  });

  it("(6e) agente SEM a tool de retorno: o veto não ensina uma tool que ele não tem", () => {
    const v = casePromiseGate.evaluate(
      baseCtx({
        body: FRASE_DA_EQUIPE,
        casesEnabled: false,
        followup: { disponivel: false, agendadoNesteTurno: false },
      }),
    );
    expect(v.pass).toBe(false);
    expect((v as { reason?: string }).reason ?? "").not.toContain("schedule_followup");
  });
});
