import { createOpenAI } from "@ai-sdk/openai";
import { generateObject, generateText } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";

/**
 * Os GPT-6 são modelos de raciocínio: a API não aceita `temperature`/`top_p`
 * neles. Quem tira esses campos do corpo é o `@ai-sdk/openai`, pela versão do id
 * (`gpt-N` com N ≥ 5) — e o motor os manda: o 0 do medidor de clima
 * (`ai-sentiment-worker`) e o de `settings.llm.params`. Este teste lê o corpo que
 * SAIRIA, sem rede: se o SDK deixar de reconhecer a linha 6, ele fica vermelho
 * antes do cliente receber o 400.
 */

function capturando(modelId: string) {
  const corpos: Record<string, unknown>[] = [];
  const model = createOpenAI({
    apiKey: "chave-falsa-do-teste",
    fetch: async (_url, init) => {
      corpos.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      throw new Error("PARADA_DE_TESTE");
    },
  })(modelId);
  return { model, corpos };
}

describe("amostragem não sai para os GPT-6", () => {
  it.each(["gpt-6-luna", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-astra"])(
    "%s: generateText e generateObject",
    async (id) => {
      const { model, corpos } = capturando(id);
      await generateText({ model, prompt: "oi", temperature: 0.4, topP: 0.9, maxRetries: 0 }).catch(
        () => {},
      );
      await generateObject({
        model,
        schema: z.object({ ok: z.boolean() }),
        prompt: "oi",
        temperature: 0,
        maxRetries: 0,
      }).catch(() => {});
      expect(corpos).toHaveLength(2);
      for (const corpo of corpos) {
        expect(corpo).not.toHaveProperty("temperature");
        expect(corpo).not.toHaveProperty("top_p");
      }
    },
  );

  it("controle: o gpt-4o-mini aceita amostragem, e ela continua saindo", async () => {
    const { model, corpos } = capturando("gpt-4o-mini");
    await generateText({ model, prompt: "oi", temperature: 0.4, maxRetries: 0 }).catch(() => {});
    expect(corpos[0]).toHaveProperty("temperature", 0.4);
  });
});
