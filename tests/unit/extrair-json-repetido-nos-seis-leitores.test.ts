import { describe, expect, it, vi } from "vitest";

import { parseLeituraDoValidador } from "../../lib/agent-engine/agent/flow-validate";
import { parseFollowupClassification, parsePlanoDeEsperas } from "../../lib/agent-engine/agent/followup-flow-classify";
import type { Logger } from "../../lib/agent-engine/obs/logger";
import { parseJailbreakClassification } from "../../lib/agent-engine/guardrails/jailbreak/classifier";
import { parsePromiseClassification } from "../../lib/agent-engine/guardrails/promise/semantic";
import { extrairJson } from "../../lib/onboarding/sugerir-funil";

/**
 * #2124 — os SEIS leitores de JSON de modelo que ainda recortavam "do primeiro
 * `{` ao último `}`" (cinco arquivos: `followup-flow-classify.ts` tem dois).
 *
 * O recorte antigo — `indexOf("{")`/`lastIndexOf("}")` em `sugerir-funil.ts` e
 * o regex gordo `/\{[\s\S]*\}/` nos outros quatro — abre no primeiro `{` e fecha
 * no ÚLTIMO `}` do texto. Quando o modelo REPETE o objeto (prosa + cópia 1 +
 * prosa + cópia 2), esse span contém AS DUAS cópias, o `JSON.parse` lança e o
 * leitor cai no ramo de falha dele — mesmo com um JSON perfeito na primeira
 * cópia. É o defeito de produção da #2124.
 *
 * Cada leitor tem exatamente dois casos:
 *
 *  1. REPETIÇÃO — prosa + JSON repetido. As duas cópias trazem valores DIFERENTES
 *     de propósito: só assim o teste diz QUAL cópia foi lida (a primeira, a
 *     estável) em vez de apenas "algo" parseou. ESTE é o caso que fica VERMELHO
 *     sem o fix.
 *  2. SEM JSON — o controle: saída sem JSON nenhum continua caindo no ramo de
 *     falha de HOJE (null / [] / flag:false+falhou:true / "sem promessa",
 *     inclusive o warn do guardrail de promessa). ESTE é o caso que prova que a
 *     semântica de falha não mudou — os dois guardrails continuam fail-open.
 */

describe("sugerir-funil — extrairJson (#2124, leitor 1 de 6)", () => {
  it("lê a PRIMEIRA cópia quando o modelo repete o objeto no meio da prosa", () => {
    const texto = [
      "Claro! Aqui está o funil sugerido:",
      "```json",
      '{"nome":"Quadro A","etapas":[{"nome":"Novo","passo":"cliente entrou"}]}',
      "```",
      "",
      "Repetindo a resposta completa:",
      '{"nome":"Quadro B","etapas":[]}',
      "",
      "Espero ter ajudado.",
    ].join("\n");

    expect(extrairJson(texto)).toEqual({
      nome: "Quadro A",
      etapas: [{ nome: "Novo", passo: "cliente entrou" }],
    });
  });

  it("saída sem JSON continua devolvendo null (o desfecho de falha de hoje)", () => {
    expect(extrairJson("Desculpe, não posso ajudar com isso.")).toBeNull();
    expect(extrairJson("")).toBeNull();
  });
});

describe("flow-validate — parseLeituraDoValidador (#2124, leitor 2 de 6)", () => {
  it("lê a PRIMEIRA cópia quando o modelo repete o objeto no meio da prosa", () => {
    const texto = [
      "Aqui estão as respostas que encontrei na mensagem:",
      '{"respostas":[{"campo":"troca_ano","valor":"2020"}]}',
      "",
      "Repetindo, agora com outro ano:",
      '{"respostas":[{"campo":"troca_ano","valor":"1999"}]}',
    ].join("\n");

    expect(parseLeituraDoValidador(texto)).toEqual({
      respostas: [{ campo: "troca_ano", valor: "2020" }],
    });
  });

  it("saída sem JSON continua devolvendo null (o desfecho de falha de hoje)", () => {
    expect(parseLeituraDoValidador("não sei")).toBeNull();
  });
});

describe("followup-flow-classify — parseFollowupClassification (#2124, leitor 3 de 6)", () => {
  it("lê a PRIMEIRA cópia quando o modelo repete o objeto no meio da prosa", () => {
    const texto = [
      "Classificação da última resposta do lead:",
      '{"class": "hot"}',
      "",
      "Repetindo a classificação:",
      '{"class": "cold"}',
    ].join("\n");

    expect(parseFollowupClassification(texto, ["hot", "cold"])).toBe("hot");
  });

  it("saída sem JSON continua devolvendo null (o desfecho de falha de hoje)", () => {
    expect(parseFollowupClassification("desculpe, não sei responder", ["hot", "cold"])).toBeNull();
  });
});

describe("followup-flow-classify — parsePlanoDeEsperas (#2124, leitor 4 de 6)", () => {
  it("lê a PRIMEIRA cópia quando o modelo repete o objeto no meio da prosa", () => {
    const texto = [
      "Plano de esperas proposto para o fluxo:",
      '{"esperas":[{"node_id":"n1","aguardar_ms":1000,"motivo":"primeira escolha"}]}',
      "",
      "Repetindo o plano, agora com outra espera:",
      '{"esperas":[{"node_id":"n1","aguardar_ms":7200000,"motivo":"segunda escolha"}]}',
    ].join("\n");

    expect(parsePlanoDeEsperas(texto, ["n1"])).toEqual([
      { node_id: "n1", aguardar_ms: 1000, motivo: "primeira escolha" },
    ]);
  });

  it("saída sem JSON continua devolvendo [] (o desfecho de falha de hoje)", () => {
    expect(parsePlanoDeEsperas("talvez semana que vem", ["n1"])).toEqual([]);
  });
});

describe("guardrail de jailbreak — parseJailbreakClassification (#2124, leitor 5 de 6)", () => {
  it("lê a PRIMEIRA cópia quando o modelo repete o veredito no meio da prosa", () => {
    const texto = [
      "Análise da mensagem recebida do lead:",
      '{"level": "high", "reason": "pedido de prompt"}',
      "",
      "Repetindo o veredito, agora sem o motivo:",
      '{"level": "none", "reason": null}',
    ].join("\n");

    expect(parseJailbreakClassification(texto)).toEqual({
      flag: true,
      level: "high",
      reason: "pedido de prompt",
    });
  });

  it("saída sem JSON continua degradando para flag:false + falhou:true (fail-open de hoje)", () => {
    expect(parseJailbreakClassification("só prosa, sem veredito nenhum")).toEqual({
      flag: false,
      level: "none",
      reason: null,
      falhou: true,
    });
  });
});

describe("guardrail de promessa — parsePromiseClassification (#2124, leitor 6 de 6)", () => {
  it("lê a PRIMEIRA cópia quando o modelo repete o veredito no meio da prosa", () => {
    const warn = vi.fn();
    const log: Logger = { info: vi.fn(), warn, error: vi.fn() };
    const texto = [
      "Veredito da camada semântica:",
      '{"isPromise": true, "suspectPhrase": "te dou de graça"}',
      "",
      "Repetindo o veredito:",
      '{"isPromise": false, "suspectPhrase": null}',
    ].join("\n");

    expect(parsePromiseClassification(texto, log)).toEqual({
      isPromise: true,
      suspectPhrase: "te dou de graça",
    });
    // Leu JSON de verdade: nenhum warn de parse-fail (o recorte antigo avisava
    // `invalid_json` aqui porque o span abrangia as duas cópias).
    expect(warn).not.toHaveBeenCalled();
  });

  it("saída sem JSON continua caindo no fail-open de hoje, com o mesmo warn", () => {
    const semJson = vi.fn();
    const logSemJson: Logger = { info: vi.fn(), warn: semJson, error: vi.fn() };
    expect(parsePromiseClassification("sem veredito nenhum", logSemJson)).toEqual({
      isPromise: false,
      suspectPhrase: null,
    });
    expect(semJson).toHaveBeenCalledWith(
      expect.stringContaining('fail-open p/ "sem promessa"'),
      { event: "promise_semantic_parse_fail", reason: "no_json" },
    );

    // E um JSON candidato que não parseou continua sendo `invalid_json`, como o
    // critério de antes ({…} havia para o regex gordo, mas não parseava).
    const invalido = vi.fn();
    const logInvalido: Logger = { info: vi.fn(), warn: invalido, error: vi.fn() };
    expect(parsePromiseClassification("isto aqui não fecha: {quebrado}", logInvalido)).toEqual({
      isPromise: false,
      suspectPhrase: null,
    });
    expect(invalido).toHaveBeenCalledWith(
      expect.stringContaining('fail-open p/ "sem promessa"'),
      { event: "promise_semantic_parse_fail", reason: "invalid_json" },
    );
  });
});
