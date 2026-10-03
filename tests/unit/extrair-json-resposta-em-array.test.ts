import { describe, expect, it, vi } from "vitest";

import { parseLeituraDoValidador } from "../../lib/agent-engine/agent/flow-validate";
import { parseFollowupClassification, parsePlanoDeEsperas } from "../../lib/agent-engine/agent/followup-flow-classify";
import { parseIntentVerdict } from "../../lib/agent-engine/agent/intent-classifier";
import type { Logger } from "../../lib/agent-engine/obs/logger";
import { parseJailbreakClassification } from "../../lib/agent-engine/guardrails/jailbreak/classifier";
import { parsePromiseClassification } from "../../lib/agent-engine/guardrails/promise/semantic";
import { extrairObjetoJsonDoTexto } from "../../lib/agent-engine/texto/extrair-json-do-texto";
import { extrairJson } from "../../lib/onboarding/sugerir-funil";

/**
 * Triagem do #2144 — a resposta INTEIRA dentro de um array (`[{...}]`).
 *
 * O recorte antigo (`/\{[\s\S]*\}/`, `indexOf("{")`/`lastIndexOf("}")`) achava o
 * objeto lá dentro. `extrairJsonDoTexto` parseia o texto inteiro primeiro e
 * devolve o ARRAY — que passa pela guarda `typeof bruto !== "object"` de todo
 * leitor. Medido no head 0b1aa65a8: o guardrail de jailbreak perdia um `high`
 * (virava `falhou`), e o de promessa caía em "sem promessa" SEM o warn
 * `promise_semantic_parse_fail` — fail-open silencioso, o que o F4-08 proíbe.
 *
 * Os leitores passam a pedir OBJETO (`extrairObjetoJsonDoTexto`): array no topo
 * não é a resposta, e a varredura de blocos acha o primeiro objeto dentro dele,
 * como o recorte antigo achava. Todo caso abaixo é vermelho sem o conserto.
 */

const RESPOSTA_EM_ARRAY = (objeto: string) => `[${objeto}]`;

describe("extrairObjetoJsonDoTexto — só devolve objeto", () => {
  it("acha o objeto dentro de um array no topo", () => {
    expect(extrairObjetoJsonDoTexto('[{"a":1}]')).toEqual({ a: 1 });
  });

  it("array sem objeto e JSON escalar não são resposta: null", () => {
    expect(extrairObjetoJsonDoTexto("[1,2]")).toBeNull();
    expect(extrairObjetoJsonDoTexto('"texto"')).toBeNull();
    expect(extrairObjetoJsonDoTexto("42")).toBeNull();
  });
});

describe("os leitores leem a resposta inteira dentro de array, como o recorte antigo lia", () => {
  it("sugerir-funil", () => {
    expect(extrairJson(RESPOSTA_EM_ARRAY('{"nome":"Quadro A","etapas":[]}'))).toEqual({
      nome: "Quadro A",
      etapas: [],
    });
  });

  it("flow-validate", () => {
    expect(parseLeituraDoValidador(RESPOSTA_EM_ARRAY('{"respostas":[{"campo":"ano","valor":"2020"}]}'))).toEqual({
      respostas: [{ campo: "ano", valor: "2020" }],
    });
  });

  it("followup-flow-classify — classe", () => {
    expect(parseFollowupClassification(RESPOSTA_EM_ARRAY('{"class":"hot"}'), ["hot", "cold"])).toBe("hot");
  });

  it("followup-flow-classify — plano de esperas", () => {
    expect(
      parsePlanoDeEsperas(RESPOSTA_EM_ARRAY('{"esperas":[{"node_id":"n1","aguardar_ms":1000,"motivo":"m"}]}'), ["n1"]),
    ).toEqual([{ node_id: "n1", aguardar_ms: 1000, motivo: "m" }]);
  });

  it("intent-classifier", () => {
    const membros = [{ intentName: "vendas", intentDescription: "quer comprar", agentId: "a-1", examples: [] }];
    expect(parseIntentVerdict(RESPOSTA_EM_ARRAY('{"intent":"vendas","confidence":0.9}'), membros)).toEqual({
      intentName: "vendas",
      confidence: 0.9,
    });
  });

  it("guardrail de jailbreak — um `high` em array continua marcado", () => {
    expect(parseJailbreakClassification(RESPOSTA_EM_ARRAY('{"level":"high","reason":"x"}'))).toEqual({
      flag: true,
      level: "high",
      reason: "x",
    });
  });

  it("guardrail de promessa — lê a promessa em array, sem warn", () => {
    const warn = vi.fn();
    const log: Logger = { info: vi.fn(), warn, error: vi.fn() };
    expect(parsePromiseClassification(RESPOSTA_EM_ARRAY('{"isPromise":true,"suspectPhrase":"x"}'), log)).toEqual({
      isPromise: true,
      suspectPhrase: "x",
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("guardrail de promessa — array sem objeto é fail-open COM o warn", () => {
    const warn = vi.fn();
    const log: Logger = { info: vi.fn(), warn, error: vi.fn() };
    expect(parsePromiseClassification("[1,2]", log)).toEqual({ isPromise: false, suspectPhrase: null });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('fail-open p/ "sem promessa"'), {
      event: "promise_semantic_parse_fail",
      reason: "no_json",
    });
  });
});
