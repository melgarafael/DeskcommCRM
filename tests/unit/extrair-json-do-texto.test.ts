import { describe, expect, it } from "vitest";

import { parseIntentVerdict } from "@/lib/agent-engine/agent/intent-classifier";
import type { RouterMember } from "@/lib/agent-engine/agent/router-config";
import { extrairJsonDoTexto } from "@/lib/agent-engine/texto/extrair-json-do-texto";

/**
 * Issue #2090 — "OpenRouter: respostas estruturadas (JSON) falham ou repetem
 * texto". O seam de modelo NÃO envia `response_format`: os auxiliares do agente
 * pedem JSON no PROMPT e parseiam o texto de volta. A fragilidade está no
 * parser (slice `indexOf('{')`→`lastIndexOf('}')`), que quebra com as formas
 * que modelos roteados por OpenRouter produzem (cerca de código, objeto no
 * meio de prosa e — principalmente — REPETIÇÃO do JSON).
 *
 * Estes casos eram a falha relatada: o slice antigo pegava do primeiro `{` ao
 * ÚLTIMO `}` (a segunda cópia), o parse apanhava dois objetos e a leitura
 * "JSON inválido em 7 de 11 checagens" era o veredito `null`/throw.
 */

const MEMBROS: RouterMember[] = [
  { intentName: "vendas", intentDescription: "quer comprar", agentId: "a-1", examples: [] },
  { intentName: "suporte", intentDescription: "precisa de ajuda", agentId: "a-2", examples: [] },
];

describe("extrairJsonDoTexto — tolera as formas que modelos OpenRouter produzem", () => {
  it("parseia JSON limpo (objeto)", () => {
    expect(extrairJsonDoTexto('{"intent":"vendas","confidence":0.9}')).toEqual({
      intent: "vendas",
      confidence: 0.9,
    });
  });

  it("parseia JSON limpo (array)", () => {
    expect(extrairJsonDoTexto('[1,2,{"a":3}]')).toEqual([1, 2, { a: 3 }]);
  });

  it("ignora cerca de código markdown", () => {
    const texto = '```json\n{"intent":"vendas","confidence":0.9}\n```';
    expect(extrairJsonDoTexto(texto)).toEqual({ intent: "vendas", confidence: 0.9 });
  });

  it("acha o objeto no MEIO de prosa", () => {
    const texto = 'Vou responder: {"intent":"vendas","confidence":0.9}. Até já!';
    expect(extrairJsonDoTexto(texto)).toEqual({ intent: "vendas", confidence: 0.9 });
  });

  it("com REPETIÇÃO devolve o PRIMEIRO objeto válido (o slice antigo apanhava os dois)", () => {
    const repetido =
      '{"intent":"suporte","confidence":0.8}{"intent":"suporte","confidence":0.8}';
    expect(extrairJsonDoTexto(repetido)).toEqual({ intent: "suporte", confidence: 0.8 });
  });

  it("mantém chaves e chaves variáveis dentro de STRINGS balanceadas (PII não derruba o bloco)", () => {
    // Prosa em volta → cai no caminho de varredura de blocos; o `{` e o `}`
    // dentro da string NÃO podem desbalancear o bloco.
    const texto = 'Anotou: {"a":"x } y","b":true} e fim.';
    expect(extrairJsonDoTexto(texto)).toEqual({ a: "x } y", b: true });
  });

  it("anda por aninhamento objeto/array", () => {
    const texto = 'resposta {"a":[{"b":1},{"c":2}]} ok';
    expect(extrairJsonDoTexto(texto)).toEqual({ a: [{ b: 1 }, { c: 2 }] });
  });

  it("devolve null quando não há JSON nenhum", () => {
    expect(extrairJsonDoTexto("só prosa, sem chaves")).toBeNull();
  });

  it("devolve null quando o único bloco é JSON inválido", () => {
    expect(extrairJsonDoTexto("{não é json válido")).toBeNull();
  });

  // Triagem do #2096: entradas que o recorte antigo lia e a varredura com `[`
  // como início de bloco perdia. Só `{` abre bloco — os 4 chamadores esperam objeto.
  it("um `[` sem fechamento na prosa antes do objeto não encerra a busca", () => {
    const texto = 'Resposta [ver abaixo: {"intent":"vendas","confidence":0.9}';
    expect(extrairJsonDoTexto(texto)).toEqual({ intent: "vendas", confidence: 0.9 });
  });

  it("uma citação `[1]` antes do objeto não vira a resposta", () => {
    const texto = 'Conforme [1], {"intent":"vendas","confidence":0.9}';
    expect(extrairJsonDoTexto(texto)).toEqual({ intent: "vendas", confidence: 0.9 });
  });

  it("aspas soltas dentro de `[...]` na prosa não escondem o objeto", () => {
    const texto = 'Tela [5" polegadas] {"intent":"vendas","confidence":0.9}';
    expect(extrairJsonDoTexto(texto)).toEqual({ intent: "vendas", confidence: 0.9 });
  });

  it("crases DENTRO de uma string do JSON são preservadas (o resumo do cliente não é reescrito)", () => {
    const texto = '{"resumo":"cliente mandou ```codigo``` aqui"}';
    expect(extrairJsonDoTexto(texto)).toEqual({ resumo: "cliente mandou ```codigo``` aqui" });
  });

  // Falhar fechado: um objeto INTERNO de uma saída quebrada passa no schema do
  // checkpoint (todos os campos têm default) e gravaria um checkpoint vazio,
  // apagando o resumo acumulado. Null faz o fechamento pedir correção.
  it("JSON truncado com um objeto interno já fechado devolve null, não o objeto interno", () => {
    const texto =
      '{"commitments":["enviar proposta"],"objections":[],"next_action":"aguardar","rolling_summary":"resumo","declaracao":{"nada_a_declarar":true}';
    expect(extrairJsonDoTexto(texto)).toBeNull();
  });

  it("cópia quebrada seguida de cópia boa devolve null, nunca o `declaracao` da cópia quebrada", () => {
    const texto =
      '{"commitments":["a"],"declaracao":{"nada_a_declarar":true},"rolling_summ{"commitments":["b"],"objections":[],"next_action":null,"rolling_summary":"ok","declaracao":{"nada_a_declarar":true}}';
    expect(extrairJsonDoTexto(texto)).toBeNull();
  });
});

describe("parseIntentVerdict — o gate do dono (auxiliar do agente sobrevive a saída OpenRouter)", () => {
  it("classifica com saída com cerca de código", () => {
    expect(parseIntentVerdict('```json\n{"intent":"vendas","confidence":0.9}\n```', MEMBROS)).toEqual({
      intentName: "vendas",
      confidence: 0.9,
    });
  });

  it("classifica com saída REPETIDA (o caso 'texto repetido' da issue)", () => {
    const repetido = '{"intent":"suporte","confidence":0.7}{"intent":"suporte","confidence":0.7}';
    expect(parseIntentVerdict(repetido, MEMBROS)).toEqual({
      intentName: "suporte",
      confidence: 0.7,
    });
  });

  it("não classifica intenção desconhecida (não roteia para id que o parse inventou)", () => {
    expect(parseIntentVerdict('{"intent":"furar-fila","confidence":0.9}', MEMBROS)).toEqual({
      intentName: null,
      confidence: 0,
      falhou: true,
    });
  });
});