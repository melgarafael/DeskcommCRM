import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, tool, type LanguageModel } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { loadEnv } from "../../env";
import { createDefaultRegistry, OPENROUTER_ENDPOINT } from "./providers";
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

/**
 * CLAUDE PELA OPENROUTER — os pontos de cache saem pelo corpo, e só onde devem.
 *
 * O `@ai-sdk/openai` no modo chat não converte `providerOptions.anthropic`, então
 * o prefixo estável chegava à OpenRouter sem ponto nenhum. O embrulho da fábrica
 * `openrouter` põe o `cache_control` e o `session_id` que a doc da OpenRouter
 * documenta — com OPENROUTER_PROMPT_CACHE=on, só em `anthropic/*` e só no host
 * oficial. Desligado, gateway ou outro modelo: o corpo é o do SDK puro, byte a byte.
 */
const SISTEMA = "Você é o atendente da loja.";

function prefixoComDuasFerramentas() {
  return buildStablePrefix({
    system: SISTEMA,
    tools: {
      b_agenda: tool({ description: "agenda", inputSchema: z.object({}) }),
      a_preco: tool({ description: "preço", inputSchema: z.object({}) }),
    },
    cacheTtl: "1h",
  });
}

/** Dispara o generateText e devolve o corpo JSON que saiu pelo `fetch` global. */
async function corpoQueSaiu(model: LanguageModel): Promise<Record<string, unknown>> {
  let corpo: Record<string, unknown> | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: unknown, init?: { body?: unknown }) => {
      corpo = JSON.parse(String(init?.body)) as Record<string, unknown>;
      throw new Error("PARADA_DE_TESTE");
    }),
  );
  const prefixo = prefixoComDuasFerramentas();
  await generateText({
    model,
    system: prefixo.system,
    messages: [{ role: "user", content: "oi" }],
    tools: prefixo.tools,
    maxRetries: 0,
  }).catch(() => {});
  vi.unstubAllGlobals();
  if (corpo === undefined) throw new Error("nenhum pedido saiu");
  return corpo;
}

/** O mesmo pedido pelo SDK puro, sem fábrica nossa: a régua do "nada mudou". */
function sdkPuro(modelId: string, baseURL = OPENROUTER_ENDPOINT): LanguageModel {
  return createOpenAI({ apiKey: "sk-or-teste", baseURL }).chat(modelId);
}

const CACHE_1H_COM_CAUDA = { ttl: "1h", cauda: true, sessao: "a".repeat(32) } as const;

function semOsCamposDoCache(corpo: Record<string, unknown>): Record<string, unknown> {
  const { session_id: _s, cache_control: _c, ...resto } = corpo;
  const mensagens = resto.messages as Array<{ role: string; content: unknown }>;
  const primeira = mensagens[0]!;
  const texto = Array.isArray(primeira.content)
    ? (primeira.content as Array<{ text: string }>)[0]!.text
    : primeira.content;
  return { ...resto, messages: [{ ...primeira, content: texto }, ...mensagens.slice(1)] };
}

describe("Claude pela OpenRouter: o cache_control sai no corpo", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("⭐ T1: system em bloco com 1 h, cauda na raiz, session_id — e o modelo lê o mesmo texto", async () => {
    const corpo = await corpoQueSaiu(
      createDefaultRegistry({ openrouterPromptCache: true })["openrouter"]!(
        "sk-or-teste",
        "anthropic/claude-sonnet-5",
        undefined,
        CACHE_1H_COM_CAUDA,
      ),
    );
    const mensagens = corpo.messages as Array<Record<string, unknown>>;
    expect(mensagens[0]).toEqual({
      role: "system",
      content: [{ type: "text", text: SISTEMA, cache_control: { type: "ephemeral", ttl: "1h" } }],
    });
    expect(corpo.cache_control).toEqual({ type: "ephemeral" });
    expect(corpo.session_id).toBe("a".repeat(32));
    expect(JSON.stringify(corpo.tools)).not.toContain("cache_control");
    expect(corpo).not.toHaveProperty("prompt_cache_key");
    // Tirando os três campos, sobra o pedido do SDK puro: ferramentas, ordem e
    // mensagens não mudaram.
    expect(semOsCamposDoCache(corpo)).toEqual(await corpoQueSaiu(sdkPuro("anthropic/claude-sonnet-5")));
  });

  it("T2: sem laço, a raiz sai sem cache_control; o TTL do system segue o knob", async () => {
    const corpo = await corpoQueSaiu(
      createDefaultRegistry({ openrouterPromptCache: true })["openrouter"]!(
        "sk-or-teste",
        "anthropic/claude-sonnet-5",
        undefined,
        { ttl: "5m", cauda: false, sessao: "b".repeat(32) },
      ),
    );
    const mensagens = corpo.messages as Array<{ content: Array<{ cache_control?: unknown }> }>;
    expect(mensagens[0]!.content[0]!.cache_control).toEqual({ type: "ephemeral", ttl: "5m" });
    expect(corpo).not.toHaveProperty("cache_control");
    expect(corpo.session_id).toBe("b".repeat(32));
  });

  it("T3: só anthropic/* é marcado; Gemini, GPT e Llama saem como o SDK puro", async () => {
    const registry = createDefaultRegistry({ openrouterPromptCache: true });
    const claude = await corpoQueSaiu(
      registry["openrouter"]!("sk-or-teste", "anthropic/claude-sonnet-5", undefined, CACHE_1H_COM_CAUDA),
    );
    expect(claude.session_id, "controle positivo").toBe("a".repeat(32));
    for (const id of ["google/gemini-3.5-flash", "openai/gpt-5.6-luna", "meta-llama/llama-3.3-70b-instruct"]) {
      const corpo = await corpoQueSaiu(registry["openrouter"]!("sk-or-teste", id, undefined, CACHE_1H_COM_CAUDA));
      expect(corpo, id).toEqual(await corpoQueSaiu(sdkPuro(id)));
      expect(JSON.stringify(corpo), id).not.toContain("cache_control");
      expect(corpo, id).not.toHaveProperty("session_id");
    }
  });

  it("T4: gateway do operador (e host parecido) não recebe campo nenhum; o host oficial, sim", async () => {
    const registry = createDefaultRegistry({ openrouterPromptCache: true });
    for (const gateway of ["https://meu-gateway.exemplo/v1", "https://openrouter.ai.exemplo/v1"]) {
      const corpo = await corpoQueSaiu(
        registry["openrouter"]!("sk-or-teste", "anthropic/claude-sonnet-5", gateway, CACHE_1H_COM_CAUDA),
      );
      expect(corpo, gateway).toEqual(await corpoQueSaiu(sdkPuro("anthropic/claude-sonnet-5", gateway)));
      expect(corpo, gateway).not.toHaveProperty("session_id");
      expect(corpo, gateway).not.toHaveProperty("prompt_cache_key");
      expect(JSON.stringify(corpo), gateway).not.toContain("cache_control");
    }
    for (const oficial of [undefined, "https://openrouter.ai/api/v1/"]) {
      const corpo = await corpoQueSaiu(
        registry["openrouter"]!("sk-or-teste", "anthropic/claude-sonnet-5", oficial, CACHE_1H_COM_CAUDA),
      );
      expect(corpo.session_id, String(oficial)).toBe("a".repeat(32));
      expect(corpo.cache_control, String(oficial)).toEqual({ type: "ephemeral" });
    }
  });

  it("T5: o knob — ligado por padrão; só `off` deixa o corpo do SDK puro", async () => {
    const puro = await corpoQueSaiu(sdkPuro("anthropic/claude-sonnet-5"));
    const corpoCom = async (registry: ReturnType<typeof createDefaultRegistry>) =>
      corpoQueSaiu(
        registry["openrouter"]!("sk-or-teste", "anthropic/claude-sonnet-5", undefined, CACHE_1H_COM_CAUDA),
      );

    expect(await corpoCom(createDefaultRegistry({ openrouterPromptCache: false }))).toEqual(puro);
    for (const valor of ["off", " OFF "]) {
      vi.stubEnv("OPENROUTER_PROMPT_CACHE", valor);
      expect(await corpoCom(createDefaultRegistry()), `env=${String(valor)}`).toEqual(puro);
    }
    // Vazio e ausente ligam: é a linha que o `.env.example` sempre trouxe.
    for (const valor of ["on", " ON ", "", undefined]) {
      vi.stubEnv("OPENROUTER_PROMPT_CACHE", valor);
      const corpo = await corpoCom(createDefaultRegistry());
      expect(corpo.session_id, `env=${String(valor)}`).toBe("a".repeat(32));
      expect(corpo.cache_control, `env=${String(valor)}`).toEqual({ type: "ephemeral" });
    }
    // A opção explícita vence o ambiente, como no knob da OpenAI.
    vi.stubEnv("OPENROUTER_PROMPT_CACHE", "on");
    expect(await corpoCom(createDefaultRegistry({ openrouterPromptCache: false }))).toEqual(puro);
  });

  it("T5b: sem o 4º argumento (mídia, transcrição) a fábrica é a de sempre, mesmo ligada", async () => {
    const corpo = await corpoQueSaiu(
      createDefaultRegistry({ openrouterPromptCache: true })["openrouter"]!("sk-or-teste", "anthropic/claude-sonnet-5"),
    );
    expect(corpo).toEqual(await corpoQueSaiu(sdkPuro("anthropic/claude-sonnet-5")));
  });

  it("T10: grafia errada derruba o boot do worker com o nome da variável; on, off, vazio e ` ON ` passam", () => {
    const minimo: NodeJS.ProcessEnv = {
      NODE_ENV: "test",
      SUPABASE_DB_URL: "postgresql://u:p@localhost:5432/db",
      NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-key",
    };
    expect(() => loadEnv({ ...minimo, OPENROUTER_PROMPT_CACHE: "of" })).toThrow(/OPENROUTER_PROMPT_CACHE/);
    expect(loadEnv({ ...minimo, OPENROUTER_PROMPT_CACHE: "on" }).OPENROUTER_PROMPT_CACHE).toBe("on");
    expect(loadEnv({ ...minimo, OPENROUTER_PROMPT_CACHE: "off" }).OPENROUTER_PROMPT_CACHE).toBe("off");
    expect(loadEnv({ ...minimo, OPENROUTER_PROMPT_CACHE: "" }).OPENROUTER_PROMPT_CACHE).toBeUndefined();
    expect(loadEnv(minimo).OPENROUTER_PROMPT_CACHE).toBeUndefined();
    // A mesma grafia que a fábrica aceita (T5: ` ON ` liga) passa no boot.
    expect(loadEnv({ ...minimo, OPENROUTER_PROMPT_CACHE: " ON " }).OPENROUTER_PROMPT_CACHE).toBe("on");
    expect(loadEnv({ ...minimo, OPENROUTER_PROMPT_CACHE: "  " }).OPENROUTER_PROMPT_CACHE).toBeUndefined();
  });
});
