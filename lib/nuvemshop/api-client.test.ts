// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { NuvemshopApiClient, NuvemshopApiError } from "./api-client";
import { nuvemshopApiBase } from "./config";

function resposta(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const cliente = () => new NuvemshopApiClient({ storeId: "123", accessToken: "tok" });

describe("nuvemshopApiBase", () => {
  it("usa o host real sem variável", () => {
    vi.stubEnv("NUVEMSHOP_API_BASE_URL", "");
    expect(nuvemshopApiBase()).toBe("https://api.tiendanube.com/v1");
  });
  it("aceita receptor local e apara a barra", () => {
    vi.stubEnv("NUVEMSHOP_API_BASE_URL", "http://127.0.0.1:3995/v1/");
    expect(nuvemshopApiBase()).toBe("http://127.0.0.1:3995/v1");
  });
  it("recusa esquema estranho e cai no host real", () => {
    vi.stubEnv("NUVEMSHOP_API_BASE_URL", "file:///etc/passwd");
    expect(nuvemshopApiBase()).toBe("https://api.tiendanube.com/v1");
  });
});

describe("listOrders", () => {
  it("monta a consulta com janela, página, status=any e o cabeçalho Authentication", async () => {
    const fetchMock = vi.fn().mockResolvedValue(resposta(200, "[]"));
    vi.stubGlobal("fetch", fetchMock);
    await cliente().listOrders({
      updatedAtMin: "2026-01-01T00:00:00.000Z",
      updatedAtMax: "2026-02-01T00:00:00.000Z",
      page: 3,
      perPage: 50,
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    const u = new URL(String(url));
    expect(u.pathname).toBe("/v1/123/orders");
    expect(u.searchParams.get("updated_at_min")).toBe("2026-01-01T00:00:00.000Z");
    expect(u.searchParams.get("updated_at_max")).toBe("2026-02-01T00:00:00.000Z");
    expect(u.searchParams.get("page")).toBe("3");
    expect(u.searchParams.get("per_page")).toBe("50");
    expect(u.searchParams.get("status")).toBe("any");
    expect((init as RequestInit).headers).toMatchObject({ Authentication: "bearer tok" });
  });

  it("404 'Last page is 0' (janela vazia) vira lista vazia", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      resposta(404, '{"code":404,"message":"Not Found","description":"Last page is 0"}'),
    ));
    await expect(cliente().listOrders({ updatedAtMin: "a", updatedAtMax: "b", page: 1, perPage: 50 })).resolves.toEqual([]);
  });

  it("429 carrega retryAfterMs de x-rate-limit-reset", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(resposta(429, "{}", { "x-rate-limit-reset": "1500" })));
    const err = await cliente()
      .listOrders({ updatedAtMin: "a", updatedAtMax: "b", page: 1, perPage: 50 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NuvemshopApiError);
    expect((err as NuvemshopApiError).status).toBe(429);
    expect((err as NuvemshopApiError).retryAfterMs).toBe(1500);
  });

  it("429 sem cabeçalho deixa retryAfterMs null", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(resposta(429, "{}")));
    const err = (await cliente()
      .listOrders({ updatedAtMin: "a", updatedAtMax: "b", page: 1, perPage: 50 })
      .catch((e: unknown) => e)) as NuvemshopApiError;
    expect(err.retryAfterMs).toBeNull();
  });
});

describe("getOrder", () => {
  it("404 lança not_found (pedido apagado)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(resposta(404, '{"code":404}')));
    const err = (await cliente().getOrder("55").catch((e: unknown) => e)) as NuvemshopApiError;
    expect(err.status).toBe(404);
    expect(err.code).toBe("not_found");
  });
  it("devolve o JSON do pedido", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(resposta(200, '{"id":55}')));
    await expect(cliente().getOrder("55")).resolves.toEqual({ id: 55 });
  });
});
