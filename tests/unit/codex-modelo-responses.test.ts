import { describe, expect, it, vi } from "vitest";

import type { LanguageModelV3CallOptions } from "@ai-sdk/provider";

import { criarModeloCodex } from "@/lib/ai/codex/modelo-responses";

/** SSE com um terminal `response.completed` carregando `resposta`. */
function sseDe(resposta: unknown): Response {
  const eventos = [`data: ${JSON.stringify({ type: "response.created" })}`, "", `data: ${JSON.stringify({ type: "response.completed", response: resposta })}`, ""];
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(eventos.join("\n")));
      c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const RESPOSTA_TEXTO = {
  id: "resp-1",
  model: "gpt-5.6-luna",
  output: [
    { type: "message", content: [{ type: "output_text", text: "ok" }] },
  ],
  usage: { input_tokens: 13, output_tokens: 5, output_tokens_details: { reasoning_tokens: 2 } },
};

function stubFetch(resposta: unknown = RESPOSTA_TEXTO) {
  const chamadas: Array<{ url: unknown; init?: RequestInit }> = [];
  const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
    chamadas.push({ url: input, init });
    return sseDe(resposta);
  });
  return { fetchImpl, chamadas };
}

function corpoDe(chamadas: Array<{ init?: RequestInit }>): Record<string, unknown> {
  return JSON.parse(chamadas[0]?.init?.body as string) as Record<string, unknown>;
}

const PROMPT: LanguageModelV3CallOptions = {
  prompt: [
    { role: "system", content: "Seja breve." },
    { role: "user", content: [{ type: "text" as const, text: "oi" }] },
  ],
};

describe("criarModeloCodex", () => {
  it("POST /responses com envelope de identidade e defaults do backend", async () => {
    const { fetchImpl, chamadas } = stubFetch();
    const modelo = criarModeloCodex({ accessToken: "at", accountId: "acc-1", modelId: "gpt-5.6-luna", fetchImpl });
    const r = await modelo.doGenerate(PROMPT);
    expect(chamadas).toHaveLength(1);
    expect(String(chamadas[0]?.url)).toBe("https://chatgpt.com/backend-api/codex/responses");
    const headers = new Headers(chamadas[0]?.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer at");
    expect(headers.get("ChatGPT-Account-ID")).toBe("acc-1");
    expect(headers.get("originator")).toBe("deskcomm-crm");
    const corpo = corpoDe(chamadas);
    expect(corpo).toMatchObject({
      model: "gpt-5.6-luna",
      instructions: "Seja breve.",
      stream: true,
      store: false,
    });
    expect(corpo["reasoning"]).toMatchObject({ effort: "xhigh" });
    expect(corpo).not.toHaveProperty("temperature");
    expect(r.content).toEqual([{ type: "text", text: "ok" }]);
    expect(r.finishReason).toMatchObject({ unified: "stop" });
    expect(r.usage.inputTokens).toMatchObject({ total: 13 });
    expect(r.usage.outputTokens).toMatchObject({ total: 5, reasoning: 2 });
  });

  it("sem accountId não manda o header (em vez de mandar vazio)", async () => {
    const { fetchImpl, chamadas } = stubFetch();
    const modelo = criarModeloCodex({ accessToken: "at", modelId: "m", fetchImpl });
    await modelo.doGenerate(PROMPT);
    expect(new Headers(chamadas[0]?.init?.headers).has("ChatGPT-Account-ID")).toBe(false);
  });

  it("effort sobrescrevível via providerOptions", async () => {
    const { fetchImpl, chamadas } = stubFetch();
    const modelo = criarModeloCodex({ accessToken: "at", modelId: "m", fetchImpl });
    await modelo.doGenerate({ ...PROMPT, providerOptions: { "openai-codex": { reasoningEffort: "low" } } });
    expect(corpoDe(chamadas)["reasoning"]).toMatchObject({ effort: "low" });
  });

  it("tools viram function tools e function_call volta como tool-call", async () => {
    const resposta = {
      id: "resp-2",
      output: [
        {
          type: "function_call",
          call_id: "call-9",
          name: "criar_lead",
          arguments: '{"nome":"Ana"}',
        },
      ],
      usage: { input_tokens: 40, output_tokens: 12 },
    };
    const { fetchImpl, chamadas } = stubFetch(resposta);
    const modelo = criarModeloCodex({ accessToken: "at", modelId: "m", fetchImpl });
    const r = await modelo.doGenerate({
      ...PROMPT,
      tools: [{ type: "function", name: "criar_lead", inputSchema: { type: "object" } }],
      toolChoice: { type: "auto" },
    });
    const corpo = corpoDe(chamadas);
    expect(corpo["tools"]).toMatchObject([{ type: "function", name: "criar_lead" }]);
    expect(corpo["tool_choice"]).toBe("auto");
    expect(r.content).toEqual([
      { type: "tool-call", toolCallId: "call-9", toolName: "criar_lead", input: '{"nome":"Ana"}' },
    ]);
    expect(r.finishReason).toMatchObject({ unified: "tool-calls" });
  });

  it("tool result volta como function_call_output no turno seguinte", async () => {
    const { fetchImpl, chamadas } = stubFetch();
    const modelo = criarModeloCodex({ accessToken: "at", modelId: "m", fetchImpl });
    await modelo.doGenerate({
      prompt: [
        { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "t", input: "{}" }] },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "c1",
              toolName: "t",
              output: { type: "json", value: { ok: true } },
            },
          ],
        },
      ],
    });
    const input = corpoDe(chamadas)["input"] as Array<Record<string, unknown>>;
    expect(input).toContainEqual({ type: "function_call", call_id: "c1", name: "t", arguments: "{}" });
    expect(input).toContainEqual({
      type: "function_call_output",
      call_id: "c1",
      output: '{"ok":true}',
    });
  });

  it("não-200 vira erro com status (o classificador do seam lê `status`)", async () => {
    const fetchImpl = vi.fn(async () => new Response('{"detail":"x"}', { status: 401 }));
    const modelo = criarModeloCodex({ accessToken: "ruim", modelId: "m", fetchImpl });
    let status: number | undefined;
    try {
      await modelo.doGenerate(PROMPT);
    } catch (e) {
      status = (e as { status?: number }).status;
    }
    expect(status).toBe(401);
  });

  it("stream sem terminal vira erro explícito (nunca resposta vazia silenciosa)", async () => {
    const vazia = new Response(new ReadableStream({ start(c) { c.close(); } }), { status: 200 });
    const fetchImpl = vi.fn(async () => vazia);
    const modelo = criarModeloCodex({ accessToken: "at", modelId: "m", fetchImpl });
    await expect(modelo.doGenerate(PROMPT)).rejects.toThrow(/codex_sem_terminal/);
  });
});
