import { createAnthropic } from "@ai-sdk/anthropic";
import { generateObject, generateText } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";

/**
 * Os Claude da geração 5 e 5.5 recusam com HTTP 400 `temperature`/`top_p`/`top_k`
 * fora do padrão, e forçar ferramenta (`tool_choice` any/tool) no Opus 5.5 e no
 * Sonnet 5.5. Quem decide tirar isso do corpo é o `@ai-sdk/anthropic`, pelo id:
 * a 4.0.16 não conhecia `claude-opus-5`, `claude-opus-5-5` nem `claude-haiku-5-5`
 * e mandava o `temperature` — o 0 do medidor de clima (`ai-sentiment-worker`) e o
 * de `settings.llm.params`. Este teste lê o corpo que SAIRIA, sem rede: se o SDK
 * regredir, ele fica vermelho antes do cliente receber o 400.
 */

const RESPOSTA = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  content: [{ type: "text", text: '{"ok":true}' }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
};

function capturando(modelId: string) {
  const corpos: Record<string, unknown>[] = [];
  const model = createAnthropic({
    apiKey: "chave-falsa-do-teste",
    fetch: async (_url, init) => {
      corpos.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ ...RESPOSTA, model: modelId }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  })(modelId);
  return { model, corpos };
}

const RECUSAM_AMOSTRAGEM = [
  "claude-haiku-5-5",
  "claude-sonnet-5-5",
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-sonnet-5",
];

describe("amostragem não sai para os Claude que a recusam", () => {
  it.each(RECUSAM_AMOSTRAGEM)("%s: generateText sem temperature/top_p/top_k", async (id) => {
    const { model, corpos } = capturando(id);
    await generateText({
      model,
      prompt: "oi",
      temperature: 0.4,
      topP: 0.9,
      topK: 40,
      maxOutputTokens: 64,
    });
    expect(corpos).toHaveLength(1);
    expect(corpos[0]).not.toHaveProperty("temperature");
    expect(corpos[0]).not.toHaveProperty("top_p");
    expect(corpos[0]).not.toHaveProperty("top_k");
  });

  it.each(RECUSAM_AMOSTRAGEM)(
    "%s: generateObject (o do medidor de clima) sem temperature nem ferramenta forçada",
    async (id) => {
      const { model, corpos } = capturando(id);
      await generateObject({
        model,
        schema: z.object({ ok: z.boolean() }),
        prompt: "oi",
        temperature: 0,
        maxOutputTokens: 64,
      });
      expect(corpos[0]).not.toHaveProperty("temperature");
      const escolha = (corpos[0]?.tool_choice as { type?: string } | undefined)?.type;
      expect(["any", "tool"]).not.toContain(escolha);
    },
  );

  it("controle: o Haiku 4.5 aceita amostragem, e ela continua saindo", async () => {
    const { model, corpos } = capturando("claude-haiku-4-5");
    await generateText({ model, prompt: "oi", temperature: 0.4, maxOutputTokens: 64 });
    expect(corpos[0]).toHaveProperty("temperature", 0.4);
  });
});
