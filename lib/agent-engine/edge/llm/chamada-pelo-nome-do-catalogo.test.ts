import { readFileSync } from "node:fs";
import { join } from "node:path";

import { generateText, stepCountIs, tool, type ToolSet } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { chamadaPeloNomeDoCatalogo } from "./chamada-pelo-nome-do-catalogo";
import { createFakeRegistry } from "./providers";

/**
 * O prompt antigo que manda chamar a ferramenta do catálogo pelo nome segue
 * funcionando quando, no turno, ela saiu por estar coberta pela nativa: a chamada
 * vai para a nativa, sem passo de erro. Roda o `generateText` de verdade, com o
 * modelo fake do repo — é o contrato do `repairToolCall` do SDK que está em jogo.
 */
const USO = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

async function rodar(nome: string, entrada: Record<string, unknown>, tools: ToolSet) {
  let chamadasAoModelo = 0;
  const factory = createFakeRegistry(async () => {
    chamadasAoModelo += 1;
    if (chamadasAoModelo === 1) {
      return {
        content: [{ type: "tool-call" as const, toolCallId: "c1", toolName: nome, input: JSON.stringify(entrada) }],
        finishReason: { unified: "tool-calls" as const, raw: undefined },
        usage: USO,
        warnings: [],
      };
    }
    return {
      content: [{ type: "text" as const, text: "pronto" }],
      finishReason: { unified: "stop" as const, raw: undefined },
      usage: USO,
      warnings: [],
    };
  }).anthropic;
  if (!factory) throw new Error("o provedor fake não existe");
  const r = await generateText({
    model: factory("k", "m"),
    prompt: "oi",
    tools,
    stopWhen: stepCountIs(4),
    repairToolCall: chamadaPeloNomeDoCatalogo,
  });
  return { r, chamadasAoModelo };
}

function nativas(registro: Array<{ nome: string; input: unknown }>): ToolSet {
  return {
    search_knowledge: tool({
      inputSchema: z.object({ query: z.string() }).passthrough(),
      execute: async (input) => {
        registro.push({ nome: "search_knowledge", input });
        return { trechos: [] };
      },
    }),
    schedule_followup: tool({
      inputSchema: z.object({ when: z.string(), reason: z.string().optional() }).passthrough(),
      execute: async (input) => {
        registro.push({ nome: "schedule_followup", input });
        return { ok: true };
      },
    }),
  };
}

describe("a chamada pelo nome do catálogo vai para a nativa que o cobre", () => {
  it("crm_search_knowledge executa search_knowledge, só com os campos que a nativa declara", async () => {
    const registro: Array<{ nome: string; input: unknown }> = [];
    const { r } = await rodar("crm_search_knowledge", { query: "prazo de entrega", limit: 3, assistente_id: "x" }, nativas(registro));
    expect(registro).toEqual([{ nome: "search_knowledge", input: { query: "prazo de entrega" } }]);
    expect(r.steps[0]?.toolResults.map((t) => t.toolName)).toEqual(["search_knowledge"]);
    expect(r.steps[0]?.content.some((c) => c.type === "tool-error")).toBe(false);
  });

  it("crm_schedule_followup executa schedule_followup", async () => {
    const registro: Array<{ nome: string; input: unknown }> = [];
    await rodar("crm_schedule_followup", { when: "2026-11-05T10:00:00-03:00", lead_id: "abc" }, nativas(registro));
    expect(registro).toEqual([{ nome: "schedule_followup", input: { when: "2026-11-05T10:00:00-03:00" } }]);
  });

  it("sem a nativa no turno, o nome do catálogo segue sendo erro (nada é inventado)", async () => {
    const registro: Array<{ nome: string; input: unknown }> = [];
    const { search_knowledge: _fora, ...semABusca } = nativas(registro);
    const { r } = await rodar("crm_search_knowledge", { query: "prazo" }, semABusca);
    expect(registro).toEqual([]);
    // O erro fala do nome que o modelo chamou, não de uma nativa que nem está no turno.
    const erros = r.steps[0]?.content.filter((c) => c.type === "tool-error") ?? [];
    expect(erros.map((e) => e.toolName)).toEqual(["crm_search_knowledge"]);
  });

  it("nome que nenhuma nativa cobre segue sendo erro", async () => {
    const registro: Array<{ nome: string; input: unknown }> = [];
    const { r } = await rodar("crm_delete_everything", { query: "x" }, nativas(registro));
    expect(registro).toEqual([]);
    expect(r.steps[0]?.content.some((c) => c.type === "tool-error")).toBe(true);
  });
});

describe("a fiação: toda chamada de modelo leva o conserto", () => {
  it("o bloco de opções comum ao generateText e ao streamText passa o repairToolCall", () => {
    const fonte = readFileSync(join(__dirname, "run-model-call.ts"), "utf8");
    const bloco = fonte.slice(fonte.indexOf("const opcoesBase = {"), fonte.indexOf("if (cfgUsada.provider === PROVEDOR_POR_ASSINATURA)"));
    expect(bloco).toContain("repairToolCall: chamadaPeloNomeDoCatalogo,");
  });
});
