/**
 * A AI/ML API É PROVEDOR DE PRIMEIRA CLASSE, é AGREGADOR, e a chave só vai
 * para `api.aimlapi.com`.
 *
 * Mesmo formato de `provedor-requesty.test.ts`: `provedores-x-registry.test.ts`
 * casa a lista com o registry genérico, e ESTE arquivo prende o caso concreto.
 * A diferença para a Requesty é o endpoint FIXO: sem base URL própria, a chave
 * (Bearer) nunca sai para outro host, nem quando o servidor responde redirect.
 * Por isso há testes que olham o DESTINO de cada request, não só o resultado.
 */
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EgressBlockedError } from "@/lib/agent-engine/edge/egress";
import { ehRoteador, modelCapabilities } from "@/lib/agent-engine/edge/llm/capabilities";
import { AIMLAPI_ENDPOINT, createDefaultRegistry } from "@/lib/agent-engine/edge/llm/providers";
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

describe("AI/ML API é aceita na ESCRITA", () => {
  it("está na lista única de provedores, com rótulo visível", () => {
    expect(IDS_DE_PROVEDOR).toContain("aimlapi");
    expect(ehProvedorSuportado("aimlapi")).toBe(true);
    expect(PROVEDOR_POR_ID.get("aimlapi")!.rotulo).toBe("AI/ML API");
  });

  it("o schema de versão do agente aceita provider aimlapi", () => {
    const r = versionCreateSchema.safeParse({
      system_prompt: "Você é um atendente útil e cordial.",
      provider: "aimlapi",
      model: "openai/gpt-4o-mini",
      credential_id: null,
      channel_session_id: null,
    });
    expect(r.success, r.success ? "" : JSON.stringify(r.error.issues)).toBe(true);
  });

  it("aceita qualquer id `fabricante/modelo` (agregador)", () => {
    expect(validarParProvedorModelo("aimlapi", "anthropic/claude-sonnet-4.5")).toEqual({
      valido: true,
    });
  });
});

describe("AI/ML API é executável", () => {
  it("declara endpoint fixo e onde pegar a chave", () => {
    const p = PROVEDOR_POR_ID.get("aimlapi")!;
    expect(p.aceitaEndpointProprio).toBe(false);
    expect(p.ondeExecutaComEndpointProprio).toBeNull();
    expect(p.catalogoSincronizavel).toBe(true);
    expect(p.ondePegarAChave).toBe("https://aimlapi.com/app/keys");
    // Sem país inventado: não há fonte citável no repo.
    expect(p.paisDeclarado).toBeNull();
    expect(p.fonteDoPais).toBeNull();
  });

  it("o registry de PRODUÇÃO tem a fábrica, em Chat Completions", () => {
    const fabrica = createDefaultRegistry()["aimlapi"];
    expect(fabrica).toBeTypeOf("function");
    const modelo = fabrica!("k", "openai/gpt-4o-mini") as { provider?: string };
    expect(modelo.provider).toBe("openai.chat");
  });

  it("o runtime de ENSAIO executa aimlapi (buildModel)", () => {
    const modelo = buildModel("aimlapi", "k", "openai/gpt-4o-mini") as { provider?: string };
    expect(modelo.provider).toBe("openai.chat");
  });
});

/** O registro devolve `LanguageModel`, que inclui `string`; aqui só serve a instância. */
function gerar(modelo: LanguageModel): PromiseLike<unknown> {
  if (typeof modelo === "string") throw new Error("o registro devolveu id em vez de instância");
  return modelo.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "oi" }] }] } as never);
}

describe("a chave da AI/ML API só vai para api.aimlapi.com", () => {
  it("o endpoint é exatamente https://api.aimlapi.com/v1", () => {
    expect(AIMLAPI_ENDPOINT).toBe("https://api.aimlapi.com/v1");
  });

  it("a fábrica de produção ignora um baseUrl salvo e chama api.aimlapi.com", async () => {
    const { fn, chamadas } = fetchQueAnota(() => json(500, { error: "x" }));
    vi.stubGlobal("fetch", fn);
    const modelo = createDefaultRegistry()["aimlapi"]!(
      "chave-de-teste",
      "openai/gpt-4o-mini",
      "https://gateway.exemplo/v1",
    );
    await Promise.resolve(gerar(modelo)).catch(() => undefined);
    expect(chamadas.length).toBeGreaterThan(0);
    for (const c of chamadas) {
      expect(new URL(c.url).host).toBe("api.aimlapi.com");
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
    const modelo = createDefaultRegistry()["aimlapi"]!("chave-de-teste", "openai/gpt-4o-mini");
    let erro: unknown;
    try {
      await gerar(modelo);
    } catch (e) {
      erro = e;
    }
    // O SDK pode embrulhar; o que importa é a causa e o destino das chamadas.
    const cadeia = [erro, (erro as { cause?: unknown })?.cause];
    expect(cadeia.some((e) => e instanceof EgressBlockedError)).toBe(true);
    expect(chamadas.every((c) => new URL(c.url).host === "api.aimlapi.com")).toBe(true);
  });

  it("o runtime de ensaio também bloqueia redirect para outro host", async () => {
    const { fn, chamadas } = fetchQueAnota(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://api.aimlapi.com.evil.exemplo/v1" },
        }),
    );
    vi.stubGlobal("fetch", fn);
    const modelo = buildModel("aimlapi", "chave-de-teste", "openai/gpt-4o-mini");
    let erro: unknown;
    try {
      await gerar(modelo);
    } catch (e) {
      erro = e;
    }
    const cadeia = [erro, (erro as { cause?: unknown })?.cause];
    expect(cadeia.some((e) => e instanceof EgressBlockedError)).toBe(true);
    expect(chamadas.every((c) => new URL(c.url).host === "api.aimlapi.com")).toBe(true);
  });
});

describe("validador da chave da AI/ML API", () => {
  it("prova a chave em /v1/key com Bearer, sem seguir redirect", async () => {
    const { fn, chamadas } = fetchQueAnota((url) =>
      url.endsWith("/key") ? json(200, { data: {} }) : json(200, { data: [] }),
    );
    vi.stubGlobal("fetch", fn);
    await validateProviderKey("aimlapi", "chave-de-teste");
    expect(chamadas[0]).toEqual({
      url: "https://api.aimlapi.com/v1/key",
      authorization: "Bearer chave-de-teste",
      redirect: "error",
    });
    for (const c of chamadas) {
      expect(new URL(c.url).host).toBe("api.aimlapi.com");
      expect(c.redirect).toBe("error");
    }
  });

  it("o catálogo público é lido SEM a chave", async () => {
    const { fn, chamadas } = fetchQueAnota((url) =>
      url.endsWith("/key") ? json(200, { data: {} }) : json(200, { data: [] }),
    );
    vi.stubGlobal("fetch", fn);
    await validateProviderKey("aimlapi", "chave-de-teste");
    const lista = chamadas.find((c) => c.url.endsWith("/models"));
    expect(lista).toBeDefined();
    expect(lista!.authorization).toBeNull();
  });

  it("401 e 403 são chave ruim, e o catálogo nem é pedido", async () => {
    for (const status of [401, 403]) {
      const { fn, chamadas } = fetchQueAnota(() => json(status, {}));
      vi.stubGlobal("fetch", fn);
      const r = await validateProviderKey("aimlapi", "x");
      expect(r).toEqual({ ok: false, error: "auth_failed_401" });
      expect(chamadas).toHaveLength(1);
    }
  });

  it("devolve só os modelos de chat (type openai/chat-completions), sem repetir", async () => {
    const { fn } = fetchQueAnota((url) =>
      url.endsWith("/key")
        ? json(200, { data: {} })
        : json(200, {
            data: [
              { id: "openai/gpt-4o-mini", type: "openai/chat-completions" },
              { id: "openai/gpt-4o-mini", type: "openai/responses/submit" },
              { id: "anthropic/claude-sonnet-4.5", type: "openai/chat-completions" },
              { id: "anthropic/claude-sonnet-4.5", type: "anthropic/messages" },
              { id: "flux/schnell", type: "openai/image-generations" },
            ],
          }),
    );
    vi.stubGlobal("fetch", fn);
    const r = await validateProviderKey("aimlapi", "k");
    expect(r).toEqual({
      ok: true,
      models: ["openai/gpt-4o-mini", "anthropic/claude-sonnet-4.5"],
    });
  });
});

describe("prova de crédito da AI/ML API", () => {
  it("chama chat/completions em api.aimlapi.com, sem seguir redirect", async () => {
    const { fn, chamadas } = fetchQueAnota(() => json(200, { choices: [] }));
    // `baseUrl` de propósito: a AI/ML API não tem endpoint próprio, então é ignorado.
    const r = await provarSaldo("aimlapi", "chave-de-teste", "openai/gpt-4o-mini", {
      baseUrl: "https://gateway.exemplo/v1",
      fetchImpl: fn as unknown as typeof fetch,
    });
    expect(r).toEqual({ ok: true });
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]).toEqual({
      url: "https://api.aimlapi.com/v1/chat/completions",
      authorization: "Bearer chave-de-teste",
      redirect: "error",
    });
  });
});

describe("AI/ML API é AGREGADOR", () => {
  it("a capacidade sai do fabricante no prefixo do id", () => {
    expect(ehRoteador("aimlapi")).toBe(true);
    expect(modelCapabilities("aimlapi", "openai/gpt-4o-mini")).toEqual(
      modelCapabilities("openai", "gpt-4o-mini"),
    );
  });
});
