import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText, tool } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { cacheDaCauda } from "./run-model-call";
import { buildStablePrefix } from "./stable-prefix";

/**
 * O cache da Anthropic é o maior desconto da conta (leitura a 0,1× — 0,05× no
 * Sonnet 5.5 e no Opus 5.5), e quem transforma o `cacheControl` do projeto em
 * `cache_control` no corpo é o `@ai-sdk/anthropic`. Os testes do prefixo estável
 * e da cauda medem o que o PROJETO devolve; este mede o corpo que SAI, sem rede.
 * Se uma versão do SDK parar de converter, a chamada continua funcionando e a
 * conta sobe calada — por isso o caso existe.
 */

const RESPOSTA = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
};

async function corpoDe(modelId: string): Promise<Record<string, unknown>> {
  let corpo: Record<string, unknown> = {};
  const model = createAnthropic({
    apiKey: "chave-falsa-do-teste",
    fetch: async (_url, init) => {
      corpo = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ ...RESPOSTA, model: modelId }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  })(modelId);
  const prefixo = buildStablePrefix({
    system: "Você é o atendente da loja.",
    tools: {
      b_agenda: tool({ description: "agenda", inputSchema: z.object({}) }),
      a_preco: tool({ description: "preço", inputSchema: z.object({}) }),
    },
    cacheTtl: "1h",
  });
  await generateText({
    model,
    system: prefixo.system,
    messages: [{ role: "user", content: "oi" }],
    tools: prefixo.tools,
    maxOutputTokens: 64,
    ...cacheDaCauda("anthropic", 4),
  });
  return corpo;
}

describe("o cache_control chega ao corpo do pedido", () => {
  it.each(["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-sonnet-5"])(
    "%s: 1 h na última tool e no system, 5 min na cauda",
    async (id) => {
      const corpo = await corpoDe(id);
      const tools = corpo.tools as Array<{ name: string; cache_control?: unknown }>;
      expect(tools.map((t) => t.name)).toEqual(["a_preco", "b_agenda"]);
      expect(tools[0]?.cache_control).toBeUndefined();
      expect(tools[1]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
      const system = corpo.system as Array<{ cache_control?: unknown }>;
      expect(system.at(-1)?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
      expect(corpo.cache_control).toEqual({ type: "ephemeral", ttl: "5m" });
    },
  );
});
