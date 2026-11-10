import { describe, expect, it } from "vitest";

import {
  casePromiseGate,
  type GateContext,
} from "@/lib/agent-engine/guardrails/before-send";
import { detectHumanPromise } from "@/lib/agent-engine/guardrails/human-promise";
import { PACING_DEFAULTS } from "@/lib/agent-engine/pacing/defaults";
import { SPINNING_DEFAULTS } from "@/lib/agent-engine/spinning/defaults";

/**
 * Issue #3725 — o cliente respondeu SÓ "Não" e o guardrail abriu caso dizendo que
 * "a IA prometeu envolver um humano". Não prometeu: OFERECEU.
 *
 * ## O cenário medido na issue
 *
 * A IA perguntou "tem algum dia ou período melhor para o contato?"; o cliente
 * respondeu só "Não"; a fala seguinte da IA foi uma OFERTA de humano com uma
 * abertura antes ("Entendi! Quer que eu encaminhe para a equipe?"). O
 * `casePromiseGate` tratou a oferta como promessa, vetou (erro-de-ensino), o
 * modelo reescreveu mantendo a oferta, o 2º veto caiu no fail-safe
 * (`inbound-turn.ts`, `case_promise_without_case`) — que abre caso e o cliente
 * recebe a frase fixa "Prefiro não arriscar aqui: passei seu pedido para um
 * atendente humano…" (lib/escalacao/aviso-ao-lead.ts, motivo `outro`).
 *
 * ## Por que o detector errava
 *
 * Em `human-promise.ts`, a isenção de consentimento era da mensagem INTEIRA:
 * `frases.every(...)` exigia TODAS as frases terminando em "?" e cada uma
 * ABRINDO com quer/posso/gostaria. Uma abertura de uma palavra — o "Entendi!"
 * que qualquer agente escreve depois de receber um "Não" — derrubava a isenção e
 * a pergunta virava promessa.
 *
 * ## O desenho: lista FECHADA de aberturas, falhando fechado
 *
 * A isenção continua sendo da mensagem inteira. A única folga é UMA abertura que
 * seja, inteira, reconhecimento sem conteúdo ("Entendi!", "Sem problema,
 * entendi!"). Qualquer outra frase devolve a análise ao texto todo, como antes.
 * Três tentativas de lista de SINAIS de promessa (verbos, posição, marcadores de
 * ação) foram refutadas, cada uma por uma família nova que escapava — os corpus
 * dessas refutações estão em `PROMESSAS` (só os que a `main` já vetava) e têm de
 * seguir vetados.
 *
 * ## O que este arquivo congela
 *
 * A OFERTA com abertura da lista não pode vetar nem abrir caso; a PROMESSA
 * continua vetando, inclusive quando vem depois de uma abertura da lista. O
 * preço do desenho, aceito de propósito (spec §10.2: na dúvida, pegar), está em
 * `SEGUEM_VETADAS_POR_DESENHO`.
 */

function baseCtx(overrides: Partial<GateContext> = {}): GateContext {
  return {
    now: new Date("2026-10-30T12:00:00Z"),
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

/**
 * Falas de OFERTA — a IA pede autorização para envolver alguém. Nenhuma promete
 * humano: quem promete é quem responde afirmativamente DEPOIS. Todas têm a forma
 * que a issue mediu: uma abertura curta (a reação ao "Não") antes da pergunta.
 */
const OFERTAS_APOS_O_NAO: readonly string[] = [
  "Entendi! Quer que eu encaminhe para a equipe verificar?",
  "Sem problema! Quer que eu veja com a equipe outro horário?",
  "Tudo bem! Posso pedir para alguém do time te ligar em outro dia?",
  "Certo! Quer que eu fale com o responsável sobre isso?",
  "Ok! Quer que eu chame alguém do time para te ajudar?",
  "Tudo bem! Quer falar com alguém da equipe?",
  "Sem problema! Você quer que eu peça para o setor verificar?",
];

/**
 * Falas de PROMESSA — a mesma família de antes do conserto. Têm de seguir vetadas
 * sem caso aberto: é a invariante sagrada de que o cliente nunca ouve "passei
 * para um humano" sem alguém de fato assumindo.
 */
const PROMESSAS: readonly string[] = [
  "Já transferi para a equipe. Você quer continuar?",
  "Vou encaminhar para o setor. Você quer?",
  "Quer que eu te transfira? Nossa equipe vai retornar hoje.",
  "Você quer falar com a equipe que já acabei de chamar?",
  "Entendi! Já encaminhei para a equipe, tudo bem?",
  "Já acionei o time. Quer que eu encaminhe para a equipe?",
  // 1ª refutação: pergunta + retorno anunciado na frase vizinha.
  "Quer que eu encaminhe para a equipe? Em breve alguém te atende.",
  "Quer que eu encaminhe para a equipe? Assim que possível você será atendido.",
  "Posso chamar o atendente? Em instantes você é atendido.",
  "Quer que eu passe para a equipe? Pode deixar que resolvem.",
  "Posso transferir para o setor financeiro? Lá resolvem isso pra você.",
  // 2ª refutação: pergunta + promessa sem verbo de retorno.
  "Quer que eu passe para a equipe? Fica tranquilo, a gente dá um jeito.",
  "Quer que eu chame o responsável? Ele te dá retorno.",
  "Quer que eu encaminhe pro time? Daqui a pouco te chamam.",
  "Quer que eu chame um especialista? Vão te orientar direitinho.",
  "Quer que eu encaminhe para a equipe? Eles sempre respondem rápido.",
  "Posso encaminhar para a equipe? Seu caso vai ser priorizado.",
  // 3ª refutação: ação já executada numa abertura curta.
  "Já encaminhei. Quer que eu chame a equipe?",
  "Já transferi. Quer falar com a equipe?",
  "Já acionei. Quer que eu chame o responsável?",
  "Já chamei. Quer que eu chame o atendente?",
  "Vou encaminhar. Quer que eu chame a equipe?",
  "Já passei adiante. Posso chamar o gerente?",
  "Encaminhei agora. Quer falar com a equipe?",
  "Já repassei. Posso falar com o gerente?",
  "Já notifiquei. Quer que eu fale com o setor?",
  // Garantia não é reconhecimento: "pode deixar"/"fica tranquilo" ficam FORA da lista.
  "Pode deixar. Quer que eu chame o responsável?",
  "Fica tranquilo. Quer que eu passe para a equipe?",
  // Abertura DA lista seguida de promessa: a folga não pode virar passe livre.
  "Entendi! Já encaminhei para a equipe.",
  "Certo! Vou encaminhar para o setor.",
  "Ok! Nossa equipe vai retornar hoje. Quer que eu encaminhe?",
  "Entendi! Quer que eu encaminhe para a equipe? Eles te retornam hoje.",
  "Combinado! Quer que eu passe para o gerente, que te liga hoje?",
  "Perfeito, encaminhado! Quer falar com a equipe?",
  "Entendi, já encaminhei! Quer falar com a equipe?",
  "Beleza! Já transferi. Quer falar com a equipe?",
  "Claro! Quer que eu encaminhe para a equipe? Em breve alguém te atende.",
  "Sem problema! Posso chamar o atendente? Em instantes você é atendido.",
  "Anotado! Vou encaminhar. Quer falar com a equipe?",
  "Entendi! Entendi! Quer que eu chame a equipe?",
];

/**
 * Ofertas que o desenho NÃO isenta, de propósito: a abertura tem conteúdo fora da
 * lista ("Vou anotar aqui."), então a análise volta à mensagem inteira, como na
 * `main`. Seguem vetadas (falso positivo conhecido, direção segura). Tirar daqui
 * exige provar que a nova folga não reabre nenhum caso de `PROMESSAS`.
 */
const SEGUEM_VETADAS_POR_DESENHO: readonly string[] = [
  "Entendi! Vou anotar aqui. Quer que eu encaminhe para a equipe?",
];

describe("#3725 — oferta de humano não é promessa de humano (detector)", () => {
  it.each(OFERTAS_APOS_O_NAO)("não detecta promessa na oferta: %s", (body) => {
    expect(detectHumanPromise(body)).toBe(false);
  });

  it.each(PROMESSAS)("continua detectando a promessa: %s", (body) => {
    expect(detectHumanPromise(body)).toBe(true);
  });

  it.each(SEGUEM_VETADAS_POR_DESENHO)("abertura fora da lista segue analisada inteira: %s", (body) => {
    expect(detectHumanPromise(body)).toBe(true);
  });

  it("mensagem que só pede consentimento continua isenta (comportamento de antes)", () => {
    expect(detectHumanPromise("Quer que eu verifique com a equipe?")).toBe(false);
  });
});

describe("#3725 — a cadeia de envio deixa passar a oferta (gate case_promise)", () => {
  it.each(OFERTAS_APOS_O_NAO)(
    "PASSA no gate, sem caso aberto e com casos ligados: %s",
    (body) => {
      const verdict = casePromiseGate.evaluate(
        baseCtx({ casesEnabled: true, hasOpenCase: false, openedCaseThisTurn: false, body }),
      );
      expect(verdict.pass).toBe(true);
    },
  );

  it.each(PROMESSAS)("VETA no gate, sem caso aberto: %s", (body) => {
    const verdict = casePromiseGate.evaluate(
      baseCtx({ casesEnabled: true, hasOpenCase: false, openedCaseThisTurn: false, body }),
    );
    expect(verdict.pass).toBe(false);
    if (!verdict.pass) expect(verdict.code).toBe("case_promise_without_case");
  });

  it("a réplica completa do cenário da issue (cliente disse só 'Não') é enviável", () => {
    // O que o modelo escreveu logo depois do "Não": reação curta + oferta.
    const corpo =
      "Sem problema, entendi! Quer que eu peça para a equipe verificar se existe outro período melhor?";
    const verdict = casePromiseGate.evaluate(baseCtx({ casesEnabled: true, body: corpo }));
    expect(verdict.pass).toBe(true);
  });
});
