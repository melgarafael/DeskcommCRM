import { generateText, tool, type FinishReason, type ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { CENARIO_DE_SILENCIO_ASSISTIDO, previewFixtureRegistry } from "./preview-fixture";
import { createFakeRegistry } from "../edge/llm/providers";
import { INSTRUCAO_DO_PEDIDO_HUMANO, previaContinuaAtePropor } from "./proposta-sob-pedido";

// O provider só reporta estes términos; "interrupted" é do SDK (ai >= 7.0.156), não do provider.
type TerminoDoProvider = Exclude<FinishReason, "interrupted">;

async function gerar(system: string, messages: ModelMessage[]) {
  const factory = previewFixtureRegistry().anthropic;
  if (!factory) throw new Error("O provedor controlado do cenário não existe.");
  const corpos: string[] = [];
  await generateText({
    model: factory("local-test-key", "test-model"),
    system,
    messages,
    tools: {
      send_message: tool({
        inputSchema: z.object({ body: z.string() }),
        execute: async ({ body }) => {
          corpos.push(body);
          return { ok: true };
        },
      }),
    },
  });
  return corpos;
}

const inbound: ModelMessage = { role: "user", content: "Bom dia! Como posso ajudar?" };

describe("provider de QA mantém silêncio até receber o pedido humano", () => {
  it("a primeira chamada da jornada fica em silêncio", async () => {
    expect(await gerar(CENARIO_DE_SILENCIO_ASSISTIDO, [inbound])).toEqual([]);
  });

  it("o mesmo texto passa a propor com a instrução humana na conversa", async () => {
    expect(await gerar(CENARIO_DE_SILENCIO_ASSISTIDO, [
      inbound,
      { role: "user", content: INSTRUCAO_DO_PEDIDO_HUMANO },
    ])).toEqual(["Bom dia! Posso ajudar com o seu pedido?"]);
  });

  it("o cenário comum preserva sua resposta anterior", async () => {
    expect(await gerar("Ajude com informações confirmadas.", [inbound])).toEqual([
      "Olá! Posso ajudar com as informações do atendimento. O que você gostaria de saber?",
    ]);
  });
});

describe("resultado vazio do SDK real só admite pedido humano quando terminou em stop", () => {
  it.each<TerminoDoProvider>([
    "stop", "content-filter", "error", "other", "length", "tool-calls",
  ])("preserva e decide pelo término %s do provider controlado", async (finishReason) => {
    const factory = createFakeRegistry(async () => ({
      content: [],
      finishReason: { unified: finishReason, raw: undefined },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 0, text: 0, reasoning: 0 },
      },
      warnings: [],
    })).anthropic;
    if (!factory) throw new Error("O provedor controlado do cenário não existe.");
    const result = await generateText({
      model: factory("local-test-key", "test-model"),
      messages: [inbound],
    });
    // Não é uma exceção: o SDK entrega o resultado vazio e o motivo à política.
    expect(result.text).toBe("");
    expect(result.finishReason).toBe(finishReason);
    expect(previaContinuaAtePropor({
      candidatos: 0,
      propostas: 0,
      impedimentos: [],
      tentativasDeEnvio: 0,
      textoEscrito: result.text,
      inboundsSemResposta: 2,
      finishReason: result.finishReason,
      saidaTruncada: false,
      tetoDePassosAtingido: false,
    })).toBe(finishReason === "stop");
  });
});
