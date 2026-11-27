import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AGENT_TOOL_DEFS,
  aplicaAChaveDeAssuntoJuridico,
  descricaoDaFerramentaDePassagem,
} from "@/lib/agent-engine/agent/inbound-turn";
import {
  casePromiseGate,
  RAZAO_DE_PASSAGEM_SEM_CASO,
  type GateContext,
} from "@/lib/agent-engine/guardrails/before-send";
import {
  deveAbrirCasoDoFailsafe,
  passagemDispensaCasoHumano,
} from "@/lib/agent-engine/guardrails/failsafe-do-caso";
import { PACING_DEFAULTS } from "@/lib/agent-engine/pacing/defaults";
import { SPINNING_DEFAULTS } from "@/lib/agent-engine/spinning/defaults";

/**
 * #5191 — COM CASOS LIGADOS, O AVISO DA PASSAGEM É O TEXTO CERTO.
 *
 * O defeito, medido na issue: a descrição de `request_human_handoff` mandava
 * "AVISE O LEAD ANTES: mande uma mensagem dizendo que você vai chamar alguém da
 * equipe"; com casos ligados, esse aviso é uma promessa de humano sem caso, e o
 * `casePromiseGate` vetava com `case_promise_without_case`. O modelo obedecia à
 * ferramenta e era barrado — e na 2ª insistência o fail-safe abria um CASO ao
 * lado da passagem (o caso duplicado do mesmo atendimento).
 *
 * Este arquivo mede os três pontos do conserto:
 *
 *   1. com a ferramenta no turno, o veto da promessa explícita de humano
 *      aponta a PASSAGEM (não um caso); a promessa segue vetada até a chamada;
 *   2. a descrição com casos ligados manda CHAMAR a ferramenta (quem avisa é o
 *      sistema) e a sem casos continua byte a byte a de hoje;
 *   3. o fail-safe dispensa o caso quando a passagem explícita está disponível,
 *      e continua abrindo caso para a promessa de humano SEM a ferramenta.
 */

const fonte = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

function baseCtx(overrides: Partial<GateContext> = {}): GateContext {
  return {
    now: new Date("2026-11-23T18:00:00Z"),
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
    casesEnabled: true,
    hasOpenCase: false,
    openedCaseThisTurn: false,
    ...overrides,
  };
}

/** As três frases medidas na issue — o aviso que a ferramenta pede. */
const AVISOS_MEDIDOS = [
  "Sua cotação está pronta! Vou chamar um consultor da equipe para finalizar com você.",
  "Perfeito! Vou passar você para um atendente da nossa equipe agora.",
  "Vou chamar alguém da equipe para te atender.",
] as const;

/** A promessa de RETOMADA do #3725/#3816 — NÃO é passagem. */
const RETOMADA = "Sem problema! Nossa equipe vai te responder outro dia.";

describe("#5191 ponto 1 — o gate aponta a passagem como destino (e só ela)", () => {
  it.each(AVISOS_MEDIDOS)(
    "com casos ligados e a ferramenta de passagem NO TURNO, o veto manda chamar request_human_handoff: %j",
    (body) => {
      // A promessa continua vetada até a chamada: o gate não prova uma chamada
      // futura, e prometer sem chamar é o handoff fantasma.
      const v = casePromiseGate.evaluate(baseCtx({ body, handoffDisponivel: true }));
      expect(v).toMatchObject({
        pass: false,
        code: "case_promise_without_case",
        reason: RAZAO_DE_PASSAGEM_SEM_CASO,
      });
    },
  );

  it.each(AVISOS_MEDIDOS)(
    "SEM a ferramenta no turno, a razão segue mandando abrir caso: %j",
    (body) => {
      const v = casePromiseGate.evaluate(baseCtx({ body }));
      expect(v).toMatchObject({ pass: false, code: "case_promise_without_case" });
      expect((v as { reason: string }).reason).toContain("open_human_case");
      expect((v as { reason: string }).reason).not.toContain("request_human_handoff");
    },
  );

  it.each(AVISOS_MEDIDOS)(
    "SEM a ferramenta no turno, o mesmo aviso continua vetado (a rede não afrouxou): %j",
    (body) => {
      const semFerramenta = casePromiseGate.evaluate(baseCtx({ body }));
      expect(semFerramenta).toMatchObject({ pass: false, code: "case_promise_without_case" });

      const desligada = casePromiseGate.evaluate(baseCtx({ body, handoffDisponivel: false }));
      expect(desligada).toMatchObject({ pass: false, code: "case_promise_without_case" });
    },
  );

  it("a passagem NÃO cobre a promessa de RETORNO — 'a equipe vai te responder' segue vetada", () => {
    const v = casePromiseGate.evaluate(
      baseCtx({
        body: RETOMADA,
        handoffDisponivel: true,
        followup: { disponivel: true, agendadoNesteTurno: false },
      }),
    );
    expect(v).toMatchObject({ pass: false, code: "case_promise_without_case" });
  });

  it("com casos DESLIGADOS, o aviso passa como sempre passou (controle)", () => {
    const v = casePromiseGate.evaluate(baseCtx({ body: AVISOS_MEDIDOS[0], casesEnabled: false }));
    expect(v).toEqual({ pass: true });
  });

  it("caso já aberto continua liberando (controle do caminho antigo)", () => {
    const v = casePromiseGate.evaluate(baseCtx({ body: AVISOS_MEDIDOS[0], hasOpenCase: true }));
    expect(v).toEqual({ pass: true });
  });
});

describe("#5191 ponto 2 — a descrição manda CHAMAR a ferramenta com casos ligados", () => {
  it("casos LIGADOS: sem 'AVISE O LEAD ANTES' e com a ordem de chamar a ferramenta", () => {
    const texto = descricaoDaFerramentaDePassagem(true, true);
    expect(texto).not.toContain("AVISE O LEAD ANTES");
    expect(texto).toContain("Chame esta ferramenta");
    expect(texto).toContain("o sistema avisa o lead");
  });

  it("casos DESLIGADOS: o texto continua o de hoje, byte a byte", () => {
    const texto = descricaoDaFerramentaDePassagem(true, false);
    expect(texto).toBe(AGENT_TOOL_DEFS.request_human_handoff.description);
    expect(texto).toContain("AVISE O LEAD ANTES");
  });

  it("a chave jurídica desligada muda só o trecho do jurídico, não o do aviso", () => {
    const texto = descricaoDaFerramentaDePassagem(false, true);
    expect(texto).not.toContain("jurídica");
    expect(texto).toContain("questão financeira sensível");
    expect(texto).not.toContain("AVISE O LEAD ANTES");
    expect(texto).toContain("Chame esta ferramenta");
  });

  it("a troca no turno usa o MESMO ponto, agora com o estado dos casos", () => {
    const tools: Record<string, unknown> = {
      request_human_handoff: { description: "antiga", execute: () => "passou" },
    };
    aplicaAChaveDeAssuntoJuridico(tools, true, true);
    const descricao = (tools.request_human_handoff as { description: string }).description;
    expect(descricao).not.toContain("AVISE O LEAD ANTES");
    expect(descricao).toContain("Chame esta ferramenta");
    expect((tools.request_human_handoff as { execute: () => string }).execute()).toBe("passou");
  });

  it("sem casos, a troca devolve o texto antigo (nada muda para quem não ligou)", () => {
    const tools: Record<string, unknown> = {
      request_human_handoff: { description: "antiga", execute: () => "passou" },
    };
    aplicaAChaveDeAssuntoJuridico(tools, true);
    expect(tools.request_human_handoff).toMatchObject({
      description: AGENT_TOOL_DEFS.request_human_handoff.description,
    });
  });
});

describe("#5191 ponto 3 — o fail-safe não abre caso quando a passagem está disponível", () => {
  const PASSAGEM = "Vou chamar um consultor da equipe para finalizar com você.";
  const CONVERSA_DO_NAO = [
    { direction: "outbound", body: "Tem algum dia ou período melhor para o contato?" },
    { direction: "inbound", body: "Não" },
  ] as const;

  it("passagem explícita + ferramenta no turno dispensa o caso", () => {
    expect(passagemDispensaCasoHumano({ corpo: PASSAGEM, passagemDisponivel: true })).toBe(true);
  });

  it("a MESMA promessa SEM a ferramenta continua abrindo caso (é a garantia anti-alucinação)", () => {
    expect(passagemDispensaCasoHumano({ corpo: PASSAGEM, passagemDisponivel: false })).toBe(false);
    expect(deveAbrirCasoDoFailsafe({ mensagens: CONVERSA_DO_NAO, corpo: PASSAGEM })).toBe(true);
  });

  it("promessa de RETORNO não é passagem: o caso segue a régua do #3725", () => {
    expect(passagemDispensaCasoHumano({ corpo: RETOMADA, passagemDisponivel: true })).toBe(false);
  });

  it("no turno, a dispensa roda ANTES do openCase do fail-safe", () => {
    const turno = fonte("lib/agent-engine/agent/inbound-turn.ts");
    const inicio = turno.indexOf("chain.code === 'case_promise_without_case'");
    expect(inicio, "o fail-safe do case_promise sumiu do turno").toBeGreaterThan(-1);
    const bloco = turno.slice(inicio, inicio + 6000);
    const dispensa = bloco.indexOf("passagemDispensaCasoHumano(");
    const abreCaso = bloco.indexOf("const auto = await openCase(");
    expect(dispensa, "a dispensa da passagem não está no fail-safe").toBeGreaterThan(-1);
    expect(abreCaso, "o auto-abre-caso do fail-safe sumiu").toBeGreaterThan(-1);
    expect(dispensa, "a dispensa do caso veio DEPOIS de já ter aberto").toBeLessThan(abreCaso);
    // A guarda tem de ser um `if (<dispensa>)` de verdade — não um caminho
    // desligado por constante, nem uma chamada que não decide nada.
    expect(bloco).toMatch(
      /if \(\s*passagemDispensaCasoHumano\(\{[\s\S]{0,500}?\}\)\s*\)\s*\{[\s\S]{0,600}?RAZAO_DE_PASSAGEM_SEM_CASO/,
    );
  });

  it("o turno informa ao gate se a ferramenta está no conjunto real", () => {
    const turno = fonte("lib/agent-engine/agent/inbound-turn.ts");
    expect(turno).toMatch(/handoffDisponivel:\s*rawTools\.request_human_handoff !== undefined/);
    expect(turno).toMatch(
      /aplicaAChaveDeAssuntoJuridico\(rawTools, agentConfig\?\.handoffLegalEnabled, casosLigados\)/,
    );
    expect(turno).toContain(
      "const casosLigados = agentConfig !== null && agentConfig.casesEnabled;",
    );
  });
});
