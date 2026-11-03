import { describe, expect, it } from "vitest";

import { registroSemEfeitoGate, type GateContext } from "@/lib/agent-engine/guardrails/before-send";
import { PACING_DEFAULTS } from "@/lib/agent-engine/pacing/defaults";
import { SPINNING_DEFAULTS } from "@/lib/agent-engine/spinning/defaults";
import {
  criarEfeitoDasEscrituras,
  type DesfechoDaEscrita,
  type EfeitoDasEscrituras,
} from "@/lib/ai/runtime/efeito-das-escritas";

/**
 * O GATE de "já registrei seu interesse" SEM o registro existir (issue #3333).
 *
 * O defeito foi medido numa imobiliária montada do zero no ambiente de teste: o agente mostra
 * os imóveis, o cliente diz "tenho interesse nesse", e o agente responde que registrou sem
 * chamar `crm_create_lead`. Com `gpt-5.6-luna`: 4 tentativas, 3 configurações de prompt, e em
 * TODAS o texto afirmou o registro sem a ferramenta. O ensino no prompt reduz o erro; não é
 * garantia — depende do modelo.
 *
 * A prova é nos DOIS sentidos, e é o que este arquivo trava:
 *   (a) registro SEM efeito → a fala NÃO sai afirmando "já registrei";
 *   (b) registro COM efeito → a MESMA fala continua saindo.
 *
 * `baseCtx` é próprio deste arquivo — mesma decisão de `gate-agenda-stall.test.ts` (sem
 * fixture compartilhada de `GateContext`, para um gate não herdar o contexto calibrado para
 * outro).
 */
function baseCtx(overrides: Partial<GateContext> = {}): GateContext {
  return {
    now: new Date("2026-10-26T12:00:00Z"),
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

/** O agente que tem a escrita medida — a única da família hoje. */
const FAMILIA = ["crm_create_lead"] as const;

/** O coletor do turno já com os desfechos que a ponte das tools teria anotado. */
function coletor(...desfechos: Array<[string, DesfechoDaEscrita]>): EfeitoDasEscrituras {
  const efeitos = criarEfeitoDasEscrituras();
  for (const [ferramenta, desfecho] of desfechos) efeitos.registrar(ferramenta, desfecho);
  return efeitos;
}

/** O turno armado: o agente tem a família, e a escrita teve estes desfechos. */
function armado(
  body: string,
  desfechos: Array<[string, DesfechoDaEscrita]> = [],
  ferramentas: readonly string[] = FAMILIA,
): GateContext {
  return baseCtx({
    body,
    registro: { active: true, ferramentas, efeitos: coletor(...desfechos) },
  });
}

/** A frase MEDIDA na issue (o relato do R5/#3328). */
const FRASE_MEDIDA =
  "Perfeito! Já registrei seu interesse na unidade 2 e a equipe vai te chamar por aqui.";

describe("registroSemEfeitoGate — a fala só afirma o que existe", () => {
  it("PROVA (a): registro FALHOU → a fala não sai afirmando que registrou", () => {
    const v = registroSemEfeitoGate.evaluate(armado(FRASE_MEDIDA, [["crm_create_lead", "falhou"]]));
    expect(v.pass).toBe(false);
    if (v.pass) throw new Error("inalcançável");
    expect(v.code).toBe("registro_afirmado_sem_efeito");
  });

  it("PROVA (b): registro PRODUZIU EFEITO → a mesma fala continua dizendo", () => {
    const v = registroSemEfeitoGate.evaluate(
      armado(FRASE_MEDIDA, [["crm_create_lead", "produziu_efeito"]]),
    );
    expect(v.pass).toBe(true);
  });

  it("sem a ferramenta ter sido chamada no turno (nao_tentada) → veta, e o ensino nomeia `crm_create_lead`", () => {
    const v = registroSemEfeitoGate.evaluate(armado(FRASE_MEDIDA));
    expect(v.pass).toBe(false);
    if (v.pass) throw new Error("inalcançável");
    expect(v.reason).toContain("crm_create_lead");
    expect(v.reason).toContain("NESTE turno");
    // O ensino do gate não é "cale": é registrar de fato, ou dizer a verdade e passar para a
    // equipe — as duas saídas em que o cliente não fica esperando um contato que não vem.
    expect(v.reason).toContain("equipe");
  });

  it("registro INCERTO (escrita sem desfecho) → veta, e o ensino proíbe afirmar E repetir a escrita", () => {
    const v = registroSemEfeitoGate.evaluate(armado(FRASE_MEDIDA, [["crm_create_lead", "incerto"]]));
    expect(v.pass).toBe(false);
    if (v.pass) throw new Error("inalcançável");
    expect(v.reason).toContain("SEM DESFECHO");
    expect(v.reason).toContain("equipe");
  });

  it("o trace leva RÓTULO, nunca o corpo (sem PII)", () => {
    const v = registroSemEfeitoGate.evaluate(armado(FRASE_MEDIDA, [["crm_create_lead", "falhou"]]));
    if (v.pass) throw new Error("esperava veto");
    expect(v.detail?.desfecho).toBe("falhou");
    expect(JSON.stringify(v.detail ?? {})).not.toContain("unidade 2");
  });

  it("efeito é MONOTÔNICO: falha posterior não apaga o registro que já existe", () => {
    // Duas tentativas no turno: a segunda estourou, mas a primeira gravou. A fala tem lastro.
    const efeitos = criarEfeitoDasEscrituras();
    efeitos.registrar("crm_create_lead", "produziu_efeito");
    efeitos.registrar("crm_create_lead", "falhou");
    const v = registroSemEfeitoGate.evaluate(
      baseCtx({ body: FRASE_MEDIDA, registro: { active: true, ferramentas: FAMILIA, efeitos } }),
    );
    expect(v.pass).toBe(true);
  });

  it("desarmado: sem `registro`, sem ferramenta de registro, ou `active:false` → no-op", () => {
    const efeitos = criarEfeitoDasEscrituras();
    for (const ctx of [
      baseCtx({ body: FRASE_MEDIDA }),
      baseCtx({ body: FRASE_MEDIDA, registro: { active: false, ferramentas: FAMILIA, efeitos } }),
      baseCtx({ body: FRASE_MEDIDA, registro: { active: true, ferramentas: [], efeitos } }),
    ]) {
      expect(registroSemEfeitoGate.evaluate(ctx).pass).toBe(true);
    }
  });

  it("o veto nomeia SÓ a ferramenta que o agente tem — nunca uma que ele não tem", () => {
    // O segundo defeito que o `agendaStallGate` já mediu: ensinar ferramenta ausente faz o
    // modelo tentar chamá-la, falhar, e a correção virar um problema novo.
    const v = registroSemEfeitoGate.evaluate(armado(FRASE_MEDIDA));
    if (v.pass) throw new Error("esperava veto");
    expect(v.reason).toContain("`crm_create_lead`");
    expect(v.reason).not.toContain("crm_update_lead");
    expect(v.reason).not.toContain("crm_move_lead_stage");
  });
});

/**
 * ─── CONTROLE NEGATIVO: a fala honesta e a fala que trata de outra coisa ─────
 *
 * Veto é bloqueio de envio. Estes casos têm de PASSAR com o agente armado e sem registro
 * nenhum no turno — e o primeiro deles é a PRÓPRIA correção que o veto pede (negar o registro
 * em vez de afirmá-lo). Um detector que casasse o verbo ignorando a negação vetaria a saída do
 * seu próprio ensino, em loop.
 */
describe("registroSemEfeitoGate — o que NÃO é afirmação de registro", () => {
  const NAO_AFIRMA = [
    "Ainda não registrei seu interesse — vou passar para a equipe e te confirmo.",
    "Não consegui registrar seu interesse agora, mas já pedi para a equipe te chamar.",
    "Vou registrar seu interesse na unidade 2 e te aviso.",
    "Seu interesse será registrado.",
    "Seu interesse pode ser registrado.",
    "Se eu registrar seu interesse, você prefere que a equipe ligue de manhã?",
    "Registrei sua visita para sábado às 10h.",
    "O sistema registra tudo automaticamente.",
    "O registro do imóvel fica no cartório.",
    "Assim que o registro sair, eu te aviso.",
  ] as const;

  it.each(NAO_AFIRMA)("passa: %s", (body) => {
    expect(registroSemEfeitoGate.evaluate(armado(body)).pass).toBe(true);
  });

  it("negação é por OCORRÊNCIA: afirmar uma unidade e negar outra continua vetando", () => {
    const v = registroSemEfeitoGate.evaluate(
      armado("Registrei seu interesse na unidade 1, mas não registrei o da unidade 2."),
    );
    expect(v.pass).toBe(false);
  });

  it("as variantes medidas da família continuam vetadas (sem efeito no turno)", () => {
    for (const body of [
      "Seu interesse já está registrado no sistema.",
      "Prontinho, cadastrei seu interesse na unidade 2.",
      "Fiz o registro do seu interesse agora.",
      "Acabei de registrar seu interesse no imóvel.",
      "Já deixei registrado o seu interesse na unidade 2.",
    ]) {
      const v = registroSemEfeitoGate.evaluate(armado(body));
      expect(v.pass, `não vetou: ${body}`).toBe(false);
    }
  });

  it("corpo vazio não é afirmação", () => {
    expect(registroSemEfeitoGate.evaluate(armado("")).pass).toBe(true);
  });
});
