import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { aiResponseHandler } from "@/workers/ai-response-worker.handler";

/**
 * Regra dura nº 12: a IA não responde em grupo.
 *
 * #2729 mudou o enunciado sem afrouxar a guarda: agora é "a IA não responde em
 * grupo A NÃO SER que o operador tenha ligado a chave por grupo
 * `ia_responde`" — e essa chave começa DESLIGADA para todo mundo. O que este
 * arquivo protege é a estrutura da regra, nas duas camadas que precisam
 * concordar:
 *
 *   1. o evento de grupo continua sendo um evento À PARTE, para que nenhum
 *      consumidor de `message.received` (IA, follow-up, campanhas, automações)
 *      enxergue mensagem de grupo sem querer — o que é o oposto do problema
 *      original de escuta dupla (PR #96);
 *   2. o motor só deixa o grupo passar quando `ia_responde === true`, e o
 *      padrão da coluna é `false`. Nulo/ausente/qualquer coisa é não.
 */
describe("a IA não responde em grupo (a não ser que o grupo libere)", () => {
  it("o worker de resposta não escuta o evento de grupo", () => {
    // A lista que o worker ASSINA é a autoridade; a leitura do texto abaixo
    // só pega a menção literal e não vê um evento montado por constante.
    expect(aiResponseHandler.events).not.toContain("message.group_received");
    expect(aiResponseHandler.events).toEqual(["message.received"]);
    const worker = readFileSync("workers/ai-response-worker.ts", "utf8");
    const handler = readFileSync("workers/ai-response-worker.handler.ts", "utf8");
    expect(worker).not.toContain("message.group_received");
    expect(handler).not.toContain("message.group_received");
  });

  it("o motor do agente mantém a segunda camada: skip do grupo + a chave por grupo", () => {
    const drain = readFileSync("lib/agent-engine/edge/crm/drain.ts", "utf8");
    // O skip continua sendo a PRIMEIRA coisa depois do run-lock — a guarda que
    // vale quando ninguém ligou a chave.
    expect(drain).toMatch(/is_group !== false/);
    // E ele só abre para a chave explícita, nunca para "tem grupo marcado".
    expect(drain).toContain("ia_responde");
    expect(drain).not.toMatch(/has_group_marker\s*\?\s*[^:]*:\s*is_group/);
    // A régua é uma função só, compartilhada com o ingest do grupo.
    expect(drain).toContain("grupoLiberaIa");
  });

  it("o padrão da chave é DESLIGADO e o que vale é `=== true` (falha fechada)", () => {
    const servico = readFileSync("lib/grupos/servico.ts", "utf8");
    expect(servico).toMatch(/definirIaDoGrupo/);
    const ingest = readFileSync("lib/grupos/ingest.ts", "utf8");
    expect(ingest).toContain("grupoLiberaIa");
    // O pedido de turno nasce do ingest do grupo, e é o MESMO evento do turno
    // da conversa individual — um consumidor (o drain) e não dois.
    expect(ingest).toContain("ai_agent.dispatch_requested");
  });
});
