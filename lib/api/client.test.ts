import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(text, {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

describe("apiClient", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("t1: POST injects Idempotency-Key (uuid) and X-Request-Id headers", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { ok: true } }));
    await apiClient.post("/x", { a: 1 });
    const headers = fetchMock.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers["X-Request-Id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(headers["Idempotency-Key"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("t2: GET injects X-Request-Id but NOT Idempotency-Key", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { ok: true } }));
    await apiClient.get("/x");
    const headers = fetchMock.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers["X-Request-Id"]).toBeTruthy();
    expect(headers["Idempotency-Key"]).toBeUndefined();
  });

  it("t3: 200 response returns parsed JSON", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { hello: "world" } }));
    const result = await apiClient.get<{ data: { hello: string } }>("/x");
    expect(result).toEqual({ data: { hello: "world" } });
  });

  it("t4: 422 response throws ApiError with status, code, and fieldErrors in details", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(422, {
        error: {
          code: "validation_error",
          message: "Validation failed",
          details: { fieldErrors: { name: ["Required"] } },
        },
      }),
    );
    await expect(apiClient.post("/x", {})).rejects.toMatchObject({
      status: 422,
      code: "validation_error",
      details: { fieldErrors: { name: ["Required"] } },
    });
  });

  it("t5: 500 response throws ApiError immediately (no retry)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(500, { error: { code: "internal_error", message: "boom" } }),
    );
    await expect(apiClient.get("/x")).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("t6: 429 with Retry-After=1 retries once and succeeds", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(
          429,
          { error: { code: "rate_limited", message: "slow down" } },
          { "Retry-After": "1" },
        ),
      )
      .mockResolvedValueOnce(jsonResponse(200, { data: { ok: true } }));
    const result = await apiClient.get<{ data: { ok: boolean } }>("/x");
    expect(result).toEqual({ data: { ok: true } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("t7: opts.idempotencyKey overrides auto-uuid", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { ok: true } }));
    await apiClient.post("/x", { a: 1 }, { idempotencyKey: "custom-key-123" });
    const headers = fetchMock.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBe("custom-key-123");
  });

  it("t8: timeout carrega um motivo descritivo — não a mensagem genérica do navegador", async () => {
    // `fetch` real, ligado a um signal abortado, rejeita com o `.reason` desse
    // signal — é esse contrato que este mock reproduz.
    fetchMock.mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
        }),
    );

    const err: unknown = await apiClient
      .get("/x", { timeoutMs: 5 })
      .catch((e: unknown) => e);

    // `DOMException` não é `instanceof Error` no Node — checa `.name`/`.message`
    // diretamente, que é a mesma superfície que qualquer chamador consulta.
    const e = err as { name: string; message: string };
    // O bug: `AbortController.abort()` sem argumento sintetiza um DOMException
    // cuja MENSAGEM LITERAL é "signal is aborted without reason" — foi isso
    // que chegou à tela como "Runtime AbortError". Trava as duas pontas: o
    // motivo tem nome reconhecível (a mesma convenção de `TimeoutError` que o
    // cliente HTTP da camada de canal já usa) e a mensagem genérica do
    // navegador não aparece mais.
    expect(e.name).toBe("TimeoutError");
    expect(e.message).not.toMatch(/aborted without reason/i);
    expect(e.message).toMatch(/\d+ms/);
  }, 10_000);
});

/**
 * A ORGANIZAÇÃO SUMIU COM A TELA ABERTA.
 *
 * Achado por Paulo em 2026-09-10, testando pela tela: revogar o acesso de quem
 * está usando o CRM naquele instante deixava a pessoa sentada lá — menu inteiro
 * no lugar, dados falhando, um aviso vermelho em inglês. A tela de acesso
 * revogado só aparecia depois de recarregar à mão.
 *
 * Nenhum teste automático pegaria isso: o defeito vive ENTRE dois carregamentos
 * de página. Os casos abaixo travam o conserto, não o defeito.
 */
describe("apiClient — quando a organização some debaixo da tela", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let reload: ReturnType<typeof vi.fn>;

  function semOrganizacao() {
    return jsonResponse(403, {
      error: { code: "no_active_org", message: "No active organization." },
    });
  }

  beforeEach(() => {
    vi.resetModules();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    reload = vi.fn();
    // `window.location.reload` não é substituível direto no jsdom.
    vi.stubGlobal("window", {
      location: { reload },
      sessionStorage: (() => {
        const caixa = new Map<string, string>();
        return {
          getItem: (k: string) => caixa.get(k) ?? null,
          setItem: (k: string, v: string) => void caixa.set(k, v),
          removeItem: (k: string) => void caixa.delete(k),
        };
      })(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("pede ao servidor que decida de novo, em vez de deixar a pessoa na tela quebrada", async () => {
    fetchMock.mockResolvedValue(semOrganizacao());
    const { apiClient: cliente } = await import("@/lib/api/client");

    // `toBeInstanceOf(ApiError)` NÃO serve aqui: o `vi.resetModules()` acima faz
    // o módulo importado dinamicamente carregar uma SEGUNDA cópia da classe, e
    // a comparação de identidade falha mesmo com o erro certo.
    await expect(cliente.get("/api/v1/conversations")).rejects.toThrow(
      "No active organization.",
    );
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("NÃO entra em laço: a segunda recusa seguida não recarrega de novo", async () => {
    // Sem esta trava o navegador piscaria para sempre — pior que o defeito.
    fetchMock.mockResolvedValue(semOrganizacao());
    const { apiClient: cliente } = await import("@/lib/api/client");

    await expect(cliente.get("/api/v1/conversations")).rejects.toThrow();
    await expect(cliente.get("/api/v1/conversations")).rejects.toThrow();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("CONTROLE — outro erro 403 não recarrega nada", async () => {
    // Sem este caso, um recarregamento em TODO 403 passaria verde — e a tela
    // piscaria em cada falta de permissão, que é situação comum.
    fetchMock.mockResolvedValue(
      jsonResponse(403, { error: { code: "forbidden", message: "sem permissão" } }),
    );
    const { apiClient: cliente } = await import("@/lib/api/client");

    await expect(cliente.get("/api/v1/conversations")).rejects.toThrow();
    expect(reload).not.toHaveBeenCalled();
  });

  it("depois que a instalação volta a responder, uma revogação futura recarrega de novo", async () => {
    // A marca tem de ser limpa no sucesso, senão a aba fica imune para sempre:
    // a pessoa entra de novo, é revogada de novo, e nada acontece.
    const { apiClient: cliente } = await import("@/lib/api/client");

    fetchMock.mockResolvedValue(semOrganizacao());
    await expect(cliente.get("/api/v1/conversations")).rejects.toThrow();
    expect(reload).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValue(jsonResponse(200, { data: [] }));
    await cliente.get("/api/v1/conversations");

    fetchMock.mockResolvedValue(semOrganizacao());
    await expect(cliente.get("/api/v1/conversations")).rejects.toThrow();
    expect(reload).toHaveBeenCalledTimes(2);
  });
});
