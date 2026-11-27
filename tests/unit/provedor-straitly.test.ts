/**
 * A Straitly É PROVEDOR DE PRIMEIRA CLASSE, é AGREGADOR, e a chave só vai
 * para `api.straitly.ai`.
 *
 * Mesmo formato de `provedor-aimlapi.test.ts`: `provedores-x-registry.test.ts`
 * casa a lista com o registry genérico, e ESTE arquivo prende o caso concreto.
 * O endpoint é FIXO (`aceitaEndpointProprio: false`): a chave (Bearer) nunca
 * sai para outro host, nem quando o servidor responde redirect.
 */
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EgressBlockedError } from "@/lib/agent-engine/edge/egress";
import { ehRoteador, modelCapabilities } from "@/lib/agent-engine/edge/llm/capabilities";
import { createDefaultRegistry, STRAITLY_ENDPOINT } from "@/lib/agent-engine/edge/llm/providers";
import { versionCreateSchema } from "@/lib/ai/agents/validation";
import { validarParProvedorModelo } from "@/lib/ai/par-provedor-modelo";
import { ehProvedorSuportado, IDS_DE_PROVEDOR, PROVEDOR_POR_ID } from "@/lib/ai/pontos/provedores";
import { validateProviderKey } from "@/lib/ai/provider-validators";
import { buildModel } from "@/lib/ai/runtime/agent";
import { provarSaldo } from "@/lib/instalacao/prova-de-credito";

afterEach(() => {
  vi.unstubAllGlobals();
});

interface Chamada {
  url: string;
  authorization: string | null;
  redirect: RequestRedirect | undefined;
}

function cabecalho(init: RequestInit | undefined, nome: string): string | null {
  const h = new Headers(init?.headers);
  return h.get(nome);
}

/** `fetch` falso que anota destino, Authorization e política de redirect. */
function fetchQueAnota(responder: (url: string) => Response) {
  const chamadas: Chamada[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    chamadas.push({
      url,
      authorization: cabecalho(init, "authorization"),
      redirect: init?.redirect,
    });
    return responder(url);
  });
  return { fn, chamadas };
}

function json(status: number, corpo: unknown): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Straitly é aceita na ESCRITA", () => {
  it("está na lista única de provedores, com rótulo visível", () => {
    expect(IDS_DE_PROVEDOR).toContain("straitly");
    expect(ehProvedorSuportado("straitly")).toBe(true);
    expect(PROVEDOR_POR_ID.get("straitly")!.rotulo).toBe("Straitly");
  });

  it("o schema de versão do agente aceita provider straitly", () => {
    const r = versionCreateSchema.safeParse({
      system_prompt: "Você é um atendente útil e cordial.",
      provider: "straitly",
      model: "deepseek/deepseek-v4-1-flash-1017",
      credential_id: null,
      channel_session_id: null,
    });
    expect(r.success, r.success ? "" : JSON.stringify(r.error.issues)).toBe(true);
  });

  it("aceita ids com ou sem prefixo de fabricante (agregador)", () => {
    expect(validarParProvedorModelo("straitly", "claude-sonnet-5-5")).toEqual({
      valido: true,
    });
    expect(validarParProvedorModelo("straitly", "deepseek/deepseek-v4-1-flash-1017")).toEqual({
      valido: true,
    });
  });
});

describe("Straitly é executável", () => {
  it("declara endpoint fixo e onde pegar a chave", () => {
    const p = PROVEDOR_POR_ID.get("straitly")!;
    expect(p.aceitaEndpointProprio).toBe(false);
    expect(p.ondeExecutaComEndpointProprio).toBeNull();
    expect(p.catalogoSincronizavel).toBe(true);
    expect(p.ondePegarAChave).toBe("https://straitly.ai/console/keys");
    // Sem país inventado: não há fonte citável no repo.
    expect(p.paisDeclarado).toBeNull();
    expect(p.fonteDoPais).toBeNull();
  });

  it("o registry de PRODUÇÃO tem a fábrica, em Chat Completions", () => {
    const fabrica = createDefaultRegistry()["straitly"];
    expect(fabrica).toBeTypeOf("function");
    const modelo = fabrica!("k", "claude-sonnet-5-5") as { provider?: string };
    expect(modelo.provider).toBe("openai.chat");
  });

  it("o runtime de ENSAIO executa straitly (buildModel)", () => {
    const modelo = buildModel("straitly", "k", "claude-sonnet-5-5") as { provider?: string };
    expect(modelo.provider).toBe("openai.chat");
  });
});

/** O registro devolve `LanguageModel`, que inclui `string`; aqui só serve a instância. */
function gerar(modelo: LanguageModel): PromiseLike<unknown> {
  if (typeof modelo === "string") throw new Error("o registro devolveu id em vez de instância");
  return modelo.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "oi" }] }] } as never);
}

describe("a chave da Straitly só vai para api.straitly.ai", () => {
  it("o endpoint é exatamente https://api.straitly.ai/v1", () => {
    expect(STRAITLY_ENDPOINT).toBe("https://api.straitly.ai/v1");
  });

  it("a fábrica de produção ignora um baseUrl salvo e chama api.straitly.ai", async () => {
    const { fn, chamadas } = fetchQueAnota(() => json(500, { error: "x" }));
    vi.stubGlobal("fetch", fn);
    const modelo = createDefaultRegistry()["straitly"]!(
      "chave-de-teste",
      "claude-sonnet-5-5",
      "https://gateway.exemplo/v1",
    );
    await Promise.resolve(gerar(modelo)).catch(() => undefined);
    expect(chamadas.length).toBeGreaterThan(0);
    for (const c of chamadas) {
      expect(new URL(c.url).host).toBe("api.straitly.ai");
    }
  });

  it("redirect para outro host é bloqueado e o Bearer não segue", async () => {
    const { fn, chamadas } = fetchQueAnota(
      () =>
        new Response(null, {
          status: 307,
          headers: { location: "https://coletor.exemplo/v1/chat/completions" },
        }),
    );
    vi.stubGlobal("fetch", fn);
    const modelo = createDefaultRegistry()["straitly"]!("chave-de-teste", "claude-sonnet-5-5");
    let erro: unknown;
    try {
      await gerar(modelo);
    } catch (e) {
      erro = e;
    }
    const cadeia = [erro, (erro as { cause?: unknown })?.cause];
    expect(cadeia.some((e) => e instanceof EgressBlockedError)).toBe(true);
    expect(chamadas.every((c) => new URL(c.url).host === "api.straitly.ai")).toBe(true);
  });

  it("o runtime de ensaio também bloqueia redirect para outro host", async () => {
    const { fn, chamadas } = fetchQueAnota(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://api.straitly.ai.evil.exemplo/v1" },
        }),
    );
    vi.stubGlobal("fetch", fn);
    const modelo = buildModel("straitly", "chave-de-teste", "claude-sonnet-5-5");
    let erro: unknown;
    try {
      await gerar(modelo);
    } catch (e) {
      erro = e;
    }
    const cadeia = [erro, (erro as { cause?: unknown })?.cause];
    expect(cadeia.some((e) => e instanceof EgressBlockedError)).toBe(true);
    expect(chamadas.every((c) => new URL(c.url).host === "api.straitly.ai")).toBe(true);
  });
});

describe("validador da chave da Straitly", () => {
  it("prova a chave em /v1/key com Bearer, sem seguir redirect", async () => {
    const { fn, chamadas } = fetchQueAnota((url) =>
      url.endsWith("/key") ? json(200, { data: {} }) : json(200, { data: [] }),
    );
    vi.stubGlobal("fetch", fn);
    await validateProviderKey("straitly", "chave-de-teste");
    expect(chamadas[0]).toEqual({
      url: "https://api.straitly.ai/v1/key",
      authorization: "Bearer chave-de-teste",
      redirect: "error",
    });
    for (const c of chamadas) {
      expect(new URL(c.url).host).toBe("api.straitly.ai");
      expect(c.redirect).toBe("error");
    }
  });

  it("o catálogo público é lido SEM a chave", async () => {
    const { fn, chamadas } = fetchQueAnota((url) =>
      url.endsWith("/key") ? json(200, { data: {} }) : json(200, { data: [] }),
    );
    vi.stubGlobal("fetch", fn);
    await validateProviderKey("straitly", "chave-de-teste");
    const lista = chamadas.find((c) => c.url.endsWith("/models"));
    expect(lista).toBeDefined();
    expect(lista!.authorization).toBeNull();
  });

  it("401 e 403 são chave ruim, e o catálogo nem é pedido", async () => {
    for (const status of [401, 403]) {
      const { fn, chamadas } = fetchQueAnota(() => json(status, {}));
      vi.stubGlobal("fetch", fn);
      const r = await validateProviderKey("straitly", "x");
      expect(r).toEqual({ ok: false, error: "auth_failed_401" });
      expect(chamadas).toHaveLength(1);
    }
  });

  it("devolve os modelos do catálogo sem repetir", async () => {
    const { fn } = fetchQueAnota((url) =>
      url.endsWith("/key")
        ? json(200, { data: {} })
        : json(200, {
            data: [
              { id: "claude-sonnet-5-5" },
              { id: "claude-sonnet-5-5" },
              { id: "deepseek/deepseek-v4-1-flash-1017" },
              { id: "" },
            ],
          }),
    );
    vi.stubGlobal("fetch", fn);
    const r = await validateProviderKey("straitly", "k");
    expect(r).toEqual({
      ok: true,
      models: ["claude-sonnet-5-5", "deepseek/deepseek-v4-1-flash-1017"],
    });
  });
});

describe("prova de crédito da Straitly", () => {
  it("chama chat/completions em api.straitly.ai, sem seguir redirect", async () => {
    const { fn, chamadas } = fetchQueAnota(() => json(200, { choices: [] }));
    // `baseUrl` de propósito: a Straitly não tem endpoint próprio, então é ignorado.
    const r = await provarSaldo("straitly", "chave-de-teste", "deepseek/deepseek-v4-1-flash-1017", {
      baseUrl: "https://gateway.exemplo/v1",
      fetchImpl: fn as unknown as typeof fetch,
    });
    expect(r).toEqual({ ok: true });
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]).toEqual({
      url: "https://api.straitly.ai/v1/chat/completions",
      authorization: "Bearer chave-de-teste",
      redirect: "error",
    });
  });
});

describe("Straitly é AGREGADOR", () => {
  it("a capacidade sai do fabricante no prefixo do id", () => {
    expect(ehRoteador("straitly")).toBe(true);
    expect(modelCapabilities("straitly", "anthropic/claude-opus-4.8")).toEqual(
      modelCapabilities("anthropic", "claude-opus-4.8"),
    );
  });
});
