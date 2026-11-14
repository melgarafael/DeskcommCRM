import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import {
  STATUS_QUE_VALE_REPETIR,
  statusValeRepetir,
  statusValeRepetirEscrita,
  tipoDeFalha,
} from "@/lib/api/retentativa";
import { textoDaFalhaDaLista } from "@/lib/inbox/falha-da-lista";
import type { ConversationsFilters } from "@/hooks/inbox/useConversationsRealtime";

/**
 * O INBOX NÃO PERDE A LISTA QUANDO A API REST TROPEÇA (#4508).
 *
 * ─── O relato ───────────────────────────────────────────────────────────────
 *
 * Instalação self-hosted: a chamada REST que alimenta o Inbox passa de 8 s, é
 * abortada por timeout, o esqueleto fica na tela e depois aparece
 *
 *     "Erro inesperado. Tente novamente."
 *
 * e, em alguns casos, a lista de conversas some — com os dados intactos no
 * banco. Quem atende fica sem a tela central de atendimento e sem saber se o
 * problema é dele, da rede ou do sistema.
 *
 * ─── O que foi medido na `origin/main` antes deste conserto ─────────────────
 *
 *   | caminho                                   | antes                          |
 *   |-------------------------------------------|--------------------------------|
 *   | leitura: 2 timeouts e a 3ª resposta       | recuperava (3 tentativas)      |
 *   | leitura: 3 timeouts                       | desistia, MAS o aviso dizia     |
 *   |                                           | "Erro inesperado" — timeout não |
 *   |                                           | é `ApiError`, caía no genérico  |
 *   | leitura: 400                              | 1 tentativa (certo)            |
 *   | leitura: 502/504                          | 1 tentativa — fora da régua     |
 *   |                                           | (o relato pede repetir 502/504) |
 *   | ESCRITA: POST com 504                     | 3 envios do mesmo corpo        |
 *   | leitura: 429/503                          | 3 x 3 = 9 requisições (duas    |
 *   |                                           | escadas: cliente HTTP + query) |
 *
 * ─── O que este arquivo trava ──────────────────────────────────────────────
 *
 *   1. duas falhas e a terceira responde → o dado chega à lista;
 *   2. três falhas → a tela diz QUE falha foi (tempo esgotado), nunca "sem
 *      conversas", e oferece tentar de novo;
 *   3. 400 → NENHUMA repetição, e a tela trata como pedido recusado;
 *   4. leitura insiste em 502/504; escrita só repete onde o servidor diz que
 *      nada aconteceu (429/503) — duplicar mensagem é pior que o timeout;
 *   5. lista já carregada sobrevive à falha do refetch.
 *
 * Duas sabotagens provam que o arquivo discrimina (ver o corpo do PR): tirar a
 * escada de retentativa reprova o caso 1; pôr 400 na régua reprova o caso 3.
 */

// ── Dublês de transporte ────────────────────────────────────────────────────

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * O `fetch` que ESTOURA POR TEMPO: ele nunca responde, e rejeita com o motivo
 * do `signal` quando o cliente aborta — que é o contrato real do navegador e o
 * que o `apiClient` produz (`DOMException` de nome `TimeoutError`).
 */
function fetchQueEstoura(init: { signal: AbortSignal }): Promise<Response> {
  return new Promise((_resolver, recusar) => {
    init.signal.addEventListener("abort", () => recusar(init.signal.reason), { once: true });
  });
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

/** Prazo curto: o teste mede a ESCADA, não os 10 s de produção. */
const PRAZO = { timeoutMs: 10 };

describe("1. duas falhas e a terceira responde — a tela mostra o dado", () => {
  it("o cliente HTTP insiste e devolve a lista; a lista renderiza a conversa", async () => {
    let tentativa = 0;
    fetchMock.mockImplementation((_url: string, init: { signal: AbortSignal }) => {
      tentativa += 1;
      if (tentativa <= 2) return fetchQueEstoura(init);
      return Promise.resolve(
        jsonResponse(200, {
          data: [{ id: "conv-1", status: "open", last_message_at: "2026-11-12T12:00:00Z" }],
          meta: { has_more: false },
        }),
      );
    });

    const resposta = await apiClient.get<{ data: { id: string }[] }>(
      "/api/v1/conversations?limit=50",
      PRAZO,
    );

    expect(tentativa).toBe(3);
    expect(resposta.data.map((c) => c.id)).toEqual(["conv-1"]);

    // A tela recebe exatamente este payload (`items` = `pages[].data`).
    montarLista({
      data: { pages: [{ data: resposta.data, meta: { has_more: false } }] },
    });
    expect(screen.getByTestId("linha")).toHaveTextContent("conv-1");
    expect(screen.queryByText(/Sem conversas por aqui/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("2. três falhas seguidas — falha visível, nunca lista vazia", () => {
  it("diz que o tempo esgotou, avisa que os dados estão salvos e oferece tentar de novo", async () => {
    fetchMock.mockImplementation((_url: string, init: { signal: AbortSignal }) =>
      fetchQueEstoura(init),
    );

    const erro: unknown = await apiClient
      .get("/api/v1/conversations?limit=50", PRAZO)
      .catch((e: unknown) => e);

    // A escada gastou as três tentativas e desistiu.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect((erro as { name?: string }).name).toBe("TimeoutError");

    montarLista({ isError: true, error: erro });

    // O motivo, com nome: era "Erro ao carregar conversas" para TODAS as falhas.
    expect(screen.getByRole("alert")).toHaveTextContent(
      "A consulta das conversas excedeu o tempo limite.",
    );
    expect(screen.getByRole("alert")).toHaveTextContent("As conversas continuam salvas.");
    expect(screen.getByRole("button", { name: "Tentar novamente" })).toBeInTheDocument();

    // O desfecho que a issue chama de pior: dizer que a caixa está vazia.
    expect(screen.queryByText(/Sem conversas por aqui/i)).not.toBeInTheDocument();
  });

  it("o aviso da falha transitória não é 'Erro inesperado'", () => {
    const semTraducao = (texto: string) => texto;
    const timeout = new DOMException("A requisição não respondeu em 10000ms.", "TimeoutError");
    expect(textoDaFalhaDaLista(timeout, semTraducao)).toBe(
      "A consulta das conversas excedeu o tempo limite.",
    );
    expect(textoDaFalhaDaLista(new TypeError("fetch failed"), semTraducao)).toBe(
      "Não foi possível falar com o servidor. Verifique a conexão.",
    );
    // O genérico continua existindo — para o que é de fato desconhecido.
    expect(textoDaFalhaDaLista(new Error("qualquer coisa"), semTraducao)).toBe(
      "Erro ao carregar conversas.",
    );
  });
});

describe("3. erro de contrato — nenhuma retentativa", () => {
  it("400 é enviado UMA vez só", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(400, { error: { code: "invalid_request", message: "cursor inválido" } }),
    );

    const erro: unknown = await apiClient
      .get("/api/v1/conversations?cursor=xx", PRAZO)
      .catch((e: unknown) => e);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(erro).toBeInstanceOf(ApiError);
    expect((erro as ApiError).status).toBe(400);
  });

  it("a régua fecha 400/401/403/404/422 e abre 429/502/503/504", () => {
    for (const status of [400, 401, 403, 404, 409, 422]) {
      expect(statusValeRepetir(status)).toBe(false);
    }
    for (const status of [429, 502, 503, 504]) {
      expect(statusValeRepetir(status)).toBe(true);
    }
    // 500 fica FORA de propósito: não está no relato e repetir um erro interno
    // é apostar que ele é transitório — decisão que não se toma sem medir.
    expect(STATUS_QUE_VALE_REPETIR.has(500)).toBe(false);

    // A ESCRITA é mais estreita: só onde o servidor DISSE que nada aconteceu.
    // 502/504 não dão essa garantia, e repetir escrita ali duplica mensagem.
    expect(statusValeRepetirEscrita(429)).toBe(true);
    expect(statusValeRepetirEscrita(503)).toBe(true);
    expect(statusValeRepetirEscrita(502)).toBe(false);
    expect(statusValeRepetirEscrita(504)).toBe(false);
  });

  it("a tela de 400 nomeia o pedido recusado, e não um timeout", () => {
    montarLista({
      isError: true,
      error: new ApiError(400, "invalid_request", undefined, "r-1", "cursor inválido"),
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "O pedido da lista de conversas foi recusado.",
    );
    expect(screen.queryByText(/tempo limite/i)).not.toBeInTheDocument();
  });
});

describe("4. leitura insiste; escrita só quando o servidor diz que nada aconteceu", () => {
  it("GET com 502 repete — é o estado que o relato pede", async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse(502, { error: { code: "bad_gateway", message: "x" } }),
    );
    await apiClient.get("/api/v1/conversations", PRAZO).catch(() => undefined);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("POST com 503 repete (o servidor DISSE que não processou, como no discador)", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(503, { error: { code: "wacalls_not_connected", message: "x" } }),
      )
      .mockResolvedValueOnce(jsonResponse(201, { data: { id: "c1" } }));
    await apiClient.post("/api/v1/voice/calls", { contactId: "x" }, PRAZO);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("POST com 504 NÃO repete — o destino pode ter processado e só a resposta sumiu", async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse(504, { error: { code: "gateway_timeout", message: "x" } }),
    );
    await apiClient.post("/api/v1/messages", { texto: "oi" }, PRAZO).catch(() => undefined);
    // Duplicar mensagem é pior que o timeout: o corpo sai UMA vez.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("5. lista já carregada sobrevive à falha", () => {
  it("erro no refetch mantém as linhas na tela", () => {
    montarLista({
      isError: true,
      error: new DOMException("tempo esgotado", "TimeoutError"),
      data: {
        pages: [
          { data: [{ id: "conv-1", status: "open" }], meta: { has_more: false } },
        ],
      },
    });
    expect(screen.getByTestId("linha")).toHaveTextContent("conv-1");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("classificação de uma ponta a outra", () => {
  it("tempo esgotado, servidor e sessão são estados distintos", () => {
    expect(tipoDeFalha(new DOMException("x", "TimeoutError"))).toBe("tempo_esgotado");
    expect(tipoDeFalha(new ApiError(503, "service_unavailable", undefined, "r"))).toBe("servidor");
    expect(tipoDeFalha(new ApiError(502, "bad_gateway", undefined, "r"))).toBe("servidor");
    expect(tipoDeFalha(new ApiError(401, "unauthenticated", undefined, "r"))).toBe("sessao");
    expect(tipoDeFalha(new ApiError(403, "forbidden", undefined, "r"))).toBe("permissao");
  });
});

// ── Harness da lista ────────────────────────────────────────────────────────

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/channels/useChannelSessions", () => ({
  useChannelSessions: () => ({ data: [] }),
}));
vi.mock("@/hooks/ai/useAutomaticoAtivo", () => ({ useAutomaticoAtivo: () => ({ data: false }) }));
vi.mock("@/components/inbox/ConversationListItem", () => ({
  ConversationListItem: ({ conversation }: { conversation: { id: string } }) => (
    <div data-testid="linha">{conversation.id}</div>
  ),
}));
vi.mock("@/hooks/inbox/useMarcarComoExemplo", () => ({
  useMarcarComoExemplo: () => ({ alternar: () => undefined, salvando: false }),
}));

const { ConversationList } = await import("@/components/inbox/ConversationList");

function montarLista(estado: Record<string, unknown>) {
  return render(
    <ConversationList
      listQuery={
        {
          data: undefined,
          isPending: false,
          isError: false,
          hasNextPage: false,
          isFetchingNextPage: false,
          fetchNextPage: vi.fn(),
          refetch: vi.fn(),
          ...estado,
        } as never
      }
      filters={{} as ConversationsFilters}
      selectedId={null}
      onSelect={() => undefined}
    />,
  );
}
