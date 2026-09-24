/**
 * `OPENROUTER_BASE_URL` vale em TODO caminho que fala com a OpenRouter — não só
 * no `resolveLanguageModel` (que `gateway-destino-por-caminho.test.ts` já cobre).
 *
 * O agente publicado (botão "Sugerir resposta", no app) e o turno do worker
 * montavam o cliente com o endereço fixo `openrouter.ai`. Quem apontava a
 * variável para um gateway compatível via os pontos do painel funcionarem e o
 * agente morrer com `401 Missing Authentication header`: a chave do gateway ia
 * para a OpenRouter.
 *
 * Técnica: `globalThis.fetch` interceptado, SDK real no caminho, nenhuma
 * chamada de rede sai. A asserção é o host de destino.
 */
import type { LanguageModel } from "ai";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const envMock: Record<string, string> = {};
vi.mock("@/lib/env", () => ({
  get env() {
    return envMock;
  },
}));

// Só o 4º caso lê banco: binding da organização em openrouter, sem `base_url`
// no painel. `@/lib/ai/gateway` fica REAL — é a constante dele que está em jogo.
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      const linha =
        tabela === "ai_purpose_bindings"
          ? { provider: "openrouter", credential_id: "cred-1", model_id: "qwen3.8-flash", base_url: null }
          : { api_key_encrypted: "x", api_key_iv: "y", api_key_tag: "z" };
      const chain = {
        select: () => chain,
        eq: () => chain,
        not: () => chain,
        maybeSingle: async () => ({ data: linha }),
      };
      return chain;
    },
  }),
}));

vi.mock("@/lib/crypto/aes_gcm", () => ({
  decryptKey: () => "chave-decifrada-da-organizacao",
  byteaToBuffer: (v: unknown) => v,
}));

const PROXY = "https://meu-proxy.example.com/v1";

let fetchOriginal: typeof globalThis.fetch;
let destinos: string[];
let caminhos: string[];

async function destinoDe(model: LanguageModel) {
  const { generateText } = await import("ai");
  try {
    await generateText({ model, prompt: "oi" });
  } catch {
    // O stub não imita o formato do provedor; o host já foi capturado.
  }
  return destinos;
}

// A primeira importação de `lib/ai/runtime/agent` transforma um grafo grande
// (medido: 34s numa máquina com load 63). Paga-se aqui, com prazo próprio, para
// o primeiro caso não estourar os 15s do teste; o `resetModules` de cada caso
// reavalia os módulos, mas a transformação fica em cache.
beforeAll(async () => {
  await import("@/lib/ai/runtime/agent");
}, 120_000);

beforeEach(() => {
  destinos = [];
  caminhos = [];
  fetchOriginal = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    destinos.push(new URL(url).host);
    caminhos.push(new URL(url).pathname);
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = fetchOriginal;
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("OPENROUTER_BASE_URL em todo caminho", () => {
  it("agente publicado (app) vai ao gateway da variável", async () => {
    vi.stubEnv("OPENROUTER_BASE_URL", PROXY);
    vi.resetModules();
    const { buildModel } = await import("@/lib/ai/runtime/agent");
    expect(await destinoDe(buildModel("openrouter", "sk-x", "qwen3.8-flash"))).toEqual([
      "meu-proxy.example.com",
    ]);
  });

  it("turno do worker, sem base_url no painel, vai ao gateway da variável", async () => {
    vi.stubEnv("OPENROUTER_BASE_URL", PROXY);
    vi.resetModules();
    const { createDefaultRegistry } = await import("@/lib/agent-engine/edge/llm/providers");
    const model = createDefaultRegistry().openrouter!("sk-x", "qwen3.8-flash");
    expect(await destinoDe(model)).toEqual(["meu-proxy.example.com"]);
  });

  it("credencial da organização, sem base_url no painel, vai ao gateway da variável", async () => {
    // Caminho de `lib/ai/gateway-binding.ts` (`instanciar`), que lê a constante
    // `OPENROUTER_BASE_URL` de `lib/ai/gateway.ts` — e não o `env` do módulo.
    vi.stubEnv("OPENROUTER_BASE_URL", PROXY);
    vi.resetModules();
    const { resolverModeloDoPonto } = await import("@/lib/ai/gateway-binding");
    const r = await resolverModeloDoPonto(
      "sentiment_classify",
      "33333333-3333-4333-8333-333333333333",
      "anthropic/claude-haiku-4-5",
    );
    expect(r?.origem).toBe("binding");
    expect(await destinoDe(r!.model)).toEqual(["meu-proxy.example.com"]);
  });

  it("sem a variável, continua na OpenRouter", async () => {
    vi.stubEnv("OPENROUTER_BASE_URL", "");
    vi.resetModules();
    const { buildModel } = await import("@/lib/ai/runtime/agent");
    expect(await destinoDe(buildModel("openrouter", "sk-x", "qwen3.8-flash"))).toEqual([
      "openrouter.ai",
    ]);
  });
});

/**
 * A OpenRouter serve `/chat/completions`; o `/responses` — o padrão de
 * `createOpenAI()(modelId)` nesta versão do SDK — não existe para todo modelo
 * lá (medido pelo @vgamkt no #1130: `google/gemini-2.5-flash-lite` devolvia
 * "Invalid JSON response"). São QUATRO fábricas que falam com a OpenRouter; o
 * conserto numa só deixava o ensaio, os workers de ponto e o gateway legado
 * ainda no endpoint que falha. Mesma técnica acima: SDK real, fetch
 * interceptado, a asserção é o caminho que saiu.
 */
describe("OpenRouter fala chat/completions em todo caminho", () => {
  beforeEach(() => vi.stubEnv("OPENROUTER_BASE_URL", ""));

  it("agente publicado (ensaio no app)", async () => {
    vi.resetModules();
    const { buildModel } = await import("@/lib/ai/runtime/agent");
    await destinoDe(buildModel("openrouter", "sk-x", "google/gemini-2.5-flash-lite"));
    expect(caminhos).toEqual(["/api/v1/chat/completions"]);
  });

  it("turno do worker", async () => {
    vi.resetModules();
    const { createDefaultRegistry } = await import("@/lib/agent-engine/edge/llm/providers");
    await destinoDe(createDefaultRegistry().openrouter!("sk-x", "google/gemini-2.5-flash-lite"));
    expect(caminhos).toEqual(["/api/v1/chat/completions"]);
  });

  it("credencial da organização (pontos de IA)", async () => {
    vi.resetModules();
    const { resolverModeloDoPonto } = await import("@/lib/ai/gateway-binding");
    const r = await resolverModeloDoPonto(
      "sentiment_classify",
      "33333333-3333-4333-8333-333333333333",
      "anthropic/claude-haiku-4-5",
    );
    await destinoDe(r!.model);
    expect(caminhos).toEqual(["/api/v1/chat/completions"]);
  });

  it("chave da instalação (resolveLanguageModel)", async () => {
    envMock.OPENROUTER_API_KEY = "sk-or-x";
    try {
      vi.resetModules();
      const { resolveLanguageModel } = await import("@/lib/ai/gateway");
      await destinoDe(resolveLanguageModel("google/gemini-2.5-flash-lite")!);
      expect(caminhos).toEqual(["/api/v1/chat/completions"]);
    } finally {
      delete envMock.OPENROUTER_API_KEY;
    }
  });
});
