/**
 * Os TRÊS caminhos de `resolveLanguageModel`, medidos pelo destino real da
 * requisição — não pelo tipo do retorno.
 *
 * `lib/ai/gateway-resolve-model.test.ts` já cobre a tabela de decisão (string =
 * gateway, objeto = provider, null = nada configurado). Este arquivo fecha o
 * degrau seguinte: o que o SDK FAZ com cada retorno. Um resolver que devolvesse
 * o objeto certo apontando para o endpoint errado passaria naquele teste e
 * falharia aqui — e é o endpoint que cobra a fatura do self-hoster.
 *
 * Técnica: `globalThis.fetch` interceptado, `ai` SDK real no caminho, nenhuma
 * chamada de rede sai. A asserção é o host de destino.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const envMock: Record<string, string> = {};
vi.mock("@/lib/env", () => ({
  get env() {
    return envMock;
  },
}));

import { resolveLanguageModel } from "@/lib/ai/gateway";

const MODELO = "anthropic/claude-haiku-4-5";

let fetchOriginal: typeof globalThis.fetch;
let destinos: string[];

/** Executa o modelo resolvido e devolve os hosts que ele tentou alcançar. */
async function destinoDe(model: NonNullable<Awaited<ReturnType<typeof resolveLanguageModel>>>) {
  const { generateText } = await import("ai");
  destinos = [];
  try {
    await generateText({ model, prompt: "oi" });
  } catch {
    // O stub responde 200 com corpo que nem sempre casa o formato do provider;
    // o que interessa já foi capturado no momento do fetch.
  }
  return destinos;
}

/**
 * O SHELL DE QUEM RODA A SUÍTE NÃO PODE DECIDIR O DESTINO MEDIDO.
 *
 * Os SDKs da Anthropic e da OpenAI honram `ANTHROPIC_BASE_URL` /
 * `OPENAI_BASE_URL` do ambiente. Quem trabalha com um proxy de modelo no shell
 * — LiteLLM, um gateway corporativo, qualquer roteador local — via o caso
 * "provider direto" falhar com `localhost:<porta>` no lugar de
 * `api.anthropic.com`, num arquivo que passa no CI e reprova na máquina de
 * quem contribui. O `@/lib/env` já está dublado; o que faltava era o
 * `process.env`, que estes SDKs leem por conta própria.
 *
 * Elas são REMOVIDAS, não fixadas num valor: o que o teste afirma é que o
 * PRODUTO escolhe o destino, e um default nosso escondendo a ausência delas
 * seria outra medida.
 */
const BASE_URLS_DO_AMBIENTE = ["ANTHROPIC_BASE_URL", "OPENAI_BASE_URL", "OPENROUTER_BASE_URL"] as const;
let baseUrlsSalvas: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of Object.keys(envMock)) delete envMock[k];
  delete process.env.AI_GATEWAY_API_KEY;
  baseUrlsSalvas = {};
  for (const k of BASE_URLS_DO_AMBIENTE) {
    baseUrlsSalvas[k] = process.env[k];
    delete process.env[k];
  }
  destinos = [];
  fetchOriginal = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    destinos.push(new URL(url).host);
    return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = fetchOriginal;
  delete process.env.AI_GATEWAY_API_KEY;
  // Devolve o ambiente de quem roda: outro arquivo da mesma execução pode
  // depender do proxy que este teste precisou tirar do caminho.
  for (const [k, v] of Object.entries(baseUrlsSalvas)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("destino real de cada caminho de resolveLanguageModel", () => {
  it("gateway da Vercel → a requisição vai para o gateway", async () => {
    envMock.AI_GATEWAY_API_KEY = "gw-key";
    // O SDK lê esta chave do process.env por conta própria quando o model é
    // string — é justamente esse acoplamento implícito que originou o bug.
    process.env.AI_GATEWAY_API_KEY = "gw-key";

    const model = resolveLanguageModel(MODELO);
    expect(model).not.toBeNull();
    expect(await destinoDe(model!)).toContain("ai-gateway.vercel.sh");
  });

  it("OpenRouter → a requisição vai para a OpenRouter, não para a Anthropic", async () => {
    envMock.OPENROUTER_API_KEY = "sk-or-xxx";
    // Chave da Anthropic presente de propósito: a precedência tem que valer.
    envMock.ANTHROPIC_API_KEY = "sk-ant-xxx";

    const model = resolveLanguageModel(MODELO);
    expect(model).not.toBeNull();
    const hosts = await destinoDe(model!);
    expect(hosts).toContain("openrouter.ai");
    expect(hosts).not.toContain("api.anthropic.com");
  });

  it("provider direto → a requisição vai para a Anthropic", async () => {
    envMock.ANTHROPIC_API_KEY = "sk-ant-xxx";

    const model = resolveLanguageModel(MODELO);
    expect(model).not.toBeNull();
    expect(await destinoDe(model!)).toContain("api.anthropic.com");
  });

  it("com gateway E OpenRouter configurados, quem roteia é o gateway", async () => {
    // A ordem é contrato de faturamento: quem tem gateway contratado espera que
    // o tráfego passe (e seja cobrado) por lá. Medir pelo tipo do retorno não
    // pega uma inversão de precedência que aponte para o endpoint errado —
    // este caso pega, porque compara os dois hosts possíveis.
    envMock.AI_GATEWAY_API_KEY = "gw-key";
    process.env.AI_GATEWAY_API_KEY = "gw-key";
    envMock.OPENROUTER_API_KEY = "sk-or-xxx";

    const model = resolveLanguageModel(MODELO);
    expect(model).not.toBeNull();
    const hosts = await destinoDe(model!);
    expect(hosts).toContain("ai-gateway.vercel.sh");
    expect(hosts).not.toContain("openrouter.ai");
  });

  it("OPENROUTER_BASE_URL customizada é respeitada (proxy/gateway próprio)", async () => {
    envMock.OPENROUTER_API_KEY = "sk-or-xxx";
    envMock.OPENROUTER_BASE_URL = "https://meu-proxy.example.com/v1";

    const model = resolveLanguageModel(MODELO);
    expect(model).not.toBeNull();
    expect(await destinoDe(model!)).toContain("meu-proxy.example.com");
  });
});
