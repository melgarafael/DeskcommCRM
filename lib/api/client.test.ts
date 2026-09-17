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

  /**
   * Timeout numa ESCRITA não é "não aconteceu" — é "não sei".
   *
   * O servidor não cancela o trabalho quando o cliente desiste: ele termina e
   * devolve para ninguém. Retentar executa a escrita de novo.
   *
   * Medido (issue #783): "Testar agente" leva ~14,5s de modelo contra um
   * timeout padrão de 10s. Um clique virava até TRÊS execuções completas do
   * LLM, as três pagas, nenhuma devolvida à tela.
   */
  function abortaSempre() {
    return (_url: string, init: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      });
  }

  it("t9: POST que estoura o tempo NÃO é repetido — a escrita pode ter acontecido", async () => {
    fetchMock.mockImplementation(abortaSempre());

    await apiClient.post("/x", { a: 1 }, { timeoutMs: 5 }).catch(() => undefined);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("t9b: PATCH e DELETE seguem a mesma regra", async () => {
    for (const chamar of [
      () => apiClient.patch("/x", { a: 1 }, { timeoutMs: 5 }),
      // `delete(path, body?, opts?)` — o `body` opcional entrou no meio quando a
      // rota de cancelar agendamento passou a exigir motivo. Escrito como
      // `delete("/x", { timeoutMs: 5 })`, este objeto virava CORPO e o `opts`
      // ficava vazio: o caso rodava com o prazo padrão e passava porque o
      // padrão de então (10s) cabia no `testTimeout` de 15s — media a contagem
      // de tentativas, nunca o prazo que dizia estar medindo.
      () => apiClient.delete("/x", undefined, { timeoutMs: 5 }),
    ]) {
      fetchMock.mockClear();
      fetchMock.mockImplementation(abortaSempre());
      await chamar().catch(() => undefined);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it("t10: GET que estoura o tempo CONTINUA sendo repetido — ler de novo é barato e seguro", async () => {
    fetchMock.mockImplementation(abortaSempre());

    await apiClient.get("/x", { timeoutMs: 5 }).catch(() => undefined);

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("t11: 429 num POST segue retentando — ali o servidor DISSE que não processou", async () => {
    // A regra nova é sobre incerteza, não sobre método: um 429 é resposta, e
    // resposta não deixa dúvida sobre o que aconteceu.
    fetchMock
      .mockResolvedValueOnce(jsonResponse(429, { error: {} }, { "Retry-After": "0" }))
      .mockResolvedValueOnce(jsonResponse(200, { data: { ok: true } }));

    await apiClient.post("/x", { a: 1 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("t11b: 503 com Retry-After num POST também repete, esperando o que o servidor pediu", async () => {
    // Contrato do discador: `POST /api/v1/voice/calls` responde 503
    // `wacalls_not_connected` + `Retry-After` quando o WaCalls diz "websocket
    // not connected" (o erro nasce ANTES de qualquer <call> sair, então repetir
    // é seguro). O comportamento do cliente já existia; este caso o PRENDE,
    // para a rota não depender de um retry que alguém poderia tirar.
    //
    // `Retry-After: "1"`, e não "0": `parseRetryAfterSeconds` descarta zero e
    // cai no backoff, e o caminho que honra o valor do servidor ficaria sem
    // medida.
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(
          503,
          { error: { code: "wacalls_not_connected", message: "sem conexão" } },
          { "Retry-After": "1" },
        ),
      )
      .mockResolvedValueOnce(jsonResponse(201, { data: { id: "c1" } }));

    const pendente = apiClient.post<{ data: { id: string } }>("/api/v1/voice/calls", {
      contactId: "x",
    });

    await vi.advanceTimersByTimeAsync(900);
    expect(fetchMock, "repetiu antes do Retry-After").toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(await pendente).toEqual({ data: { id: "c1" } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  /**
   * O ORÇAMENTO DE ESPERA DA ESCRITA (o vermelho de `followup-dossie:190`).
   *
   * Enquanto o método mutante era retentado, uma escrita tinha 10s + backoff +
   * 10s + backoff + 10s ≈ 30,6s de parede. Parar de repetir era certo; o que
   * passou despercebido é que a repetição também era o PRAZO — e ele caiu para
   * 10s em toda mutação do produto de uma vez só.
   *
   * Medido no trace do CI (run 34876435491): `POST …/pause` cortado em
   * 9999,558ms com `net::ERR_ABORTED` e UMA tentativa, num job onde os testes
   * vizinhos correram mais rápido que na `main`. Quem desistiu foi o navegador.
   *
   * Estes dois casos prendem os dois prazos, que são diferentes de propósito:
   * escrever espera 30s (desistir não cancela nada no servidor — só perde a
   * resposta), ler desiste em 10s (a tela não fica presa, e a leitura é
   * repetida, então o orçamento dela não mudou).
   */
  it("t12: escrita só desiste depois de 30s — aos 10s ela ainda está de pé", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(abortaSempre());

    const desfecho = vi.fn();
    void apiClient.post("/x", { a: 1 }).then(desfecho, desfecho);

    // 10s é o prazo da LEITURA. Se ele estiver valendo aqui, a escrita já
    // morreu neste ponto — que é exatamente o defeito.
    await vi.advanceTimersByTimeAsync(10_500);
    expect(desfecho).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(desfecho).toHaveBeenCalled();
    // E continua sem repetir: o prazo mudou, a regra do #787 não.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("t13: leitura continua desistindo aos 10s — ela é repetida, prender a tela não paga", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(abortaSempre());

    const desfecho = vi.fn();
    void apiClient.get("/x").then(desfecho, desfecho);

    // Aos 10,5s a primeira já estourou e a segunda tentativa começou.
    await vi.advanceTimersByTimeAsync(10_500);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(desfecho).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
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
