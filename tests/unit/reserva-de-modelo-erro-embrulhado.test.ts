/**
 * A reserva de modelo com o erro do jeito que o AI SDK REALMENTE lança (#4600).
 *
 * A prova de tela do #4617 mostrou o furo que os testes unitários não pegavam.
 * O `generateText` tenta de novo sozinho as falhas retentáveis (429 e 5xx) e, ao
 * desistir, lança `RetryError`, que não tem `statusCode`: o status fica em
 * `lastError`. Os testes jogavam um `APICallError` cru e passavam. No caminho
 * real, `normalizarErro` lia `null`, a reserva nunca assumia na cota nem no
 * provedor fora, e o cliente ficava sem resposta.
 *
 * Aqui o erro é montado com as classes do próprio SDK, embrulhado como ele
 * embrulha.
 */
import { describe, expect, it } from "vitest";
import { APICallError, RetryError } from "ai";

import { normalizarErro } from "@/lib/agent-engine/edge/llm/run-model-call";
import { decidirQuedaDoModeloDeReserva } from "@/lib/ai/pontos/reserva-da-assinatura";

const RESERVA = { provider: "deepseek", model: "deepseek-chat" };

function falhaDoProvedor(statusCode: number, message: string): APICallError {
  return new APICallError({
    message,
    url: "https://provedor.invalid/v1/chat/completions",
    requestBodyValues: {},
    statusCode,
    isRetryable: true,
  });
}

/** O que o `generateText` lança depois de esgotar o `maxRetries`. */
function embrulhada(statusCode: number, message: string): RetryError {
  const tentativas = [1, 2, 3].map(() => falhaDoProvedor(statusCode, message));
  return new RetryError({
    message: `Failed after 3 attempts. Last error: ${message}`,
    reason: "maxRetriesExceeded",
    errors: tentativas,
  });
}

describe("normalizarErro lê o status de dentro do RetryError", () => {
  it("429 embrulhado: status 429 e limite_ou_saldo", () => {
    const n = normalizarErro(embrulhada(429, "Rate limit exceeded"));
    expect(n.http_status).toBe(429);
    expect(n.error_code).toBe("limite_ou_saldo");
  });

  it("503 embrulhado: status 503 e provedor_indisponivel, não erro_desconhecido", () => {
    const n = normalizarErro(embrulhada(503, "Service Unavailable"));
    expect(n.http_status).toBe(503);
    expect(n.error_code).toBe("provedor_indisponivel");
  });

  it("controle: o APICallError cru continua lido como antes", () => {
    expect(normalizarErro(falhaDoProvedor(429, "Rate limit exceeded")).http_status).toBe(429);
  });

  it("controle: erro sem status em lugar nenhum continua null", () => {
    expect(normalizarErro(new Error("algo quebrou")).http_status).toBeNull();
  });
});

describe("a reserva assume com o erro embrulhado", () => {
  it.each([
    [429, "Rate limit exceeded", "cota"],
    [503, "Service Unavailable", "falha_do_provedor"],
  ] as const)("%i embrulhado ⇒ cai para a reserva (%s)", (statusCode, message, motivo) => {
    const { http_status: status, error_message: detalhe } = normalizarErro(embrulhada(statusCode, message));
    const decisao = decidirQuedaDoModeloDeReserva({ reserva: RESERVA, status, detalhe, jaCaiuParaAReserva: false });
    expect(decisao).not.toBeNull();
    expect(decisao?.motivo).toBe(motivo);
  });

  it("400 embrulhado (pedido malformado) não cai", () => {
    const { http_status: status, error_message: detalhe } = normalizarErro(embrulhada(400, "Bad Request"));
    expect(decidirQuedaDoModeloDeReserva({ reserva: RESERVA, status, detalhe, jaCaiuParaAReserva: false })).toBeNull();
  });
});
