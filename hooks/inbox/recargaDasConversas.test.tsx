/**
 * A rajada de eventos do realtime não pode cancelar a busca da lista.
 *
 * Uma mensagem que chega produz vários eventos; cada um invalidava a lista,
 * cancelando a busca anterior (no trace do CI, 5 GET em 5ms). Isto mede o
 * agrupamento, não a causa da falha intermitente do e2e
 * `encerramento-atendimento` — o controle aprovado tem a mesma rajada.
 *
 * SABOTAGEM: voltar o `onChange` de `useConversationsRealtime` para
 * `qc.invalidateQueries({ queryKey: ["conversations"] })` = os três casos
 * vermelhos (5 buscas em vez de 1; busca em voo cancelada; conversa aberta
 * nunca recarregada).
 */
import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const fakes = vi.hoisted(() => ({
  onChange: null as null | ((payload: unknown) => void),
  get: vi.fn(),
}));

vi.mock("@/hooks/realtime/useRealtimeChannel", () => ({
  useRealtimeChannel: (cfg: { onChange: (payload: unknown) => void }) => {
    fakes.onChange = cfg.onChange;
    return { status: "subscribed", ultimaEntrega: { current: null } };
  },
}));
vi.mock("@/hooks/realtime/useRefetchDeSeguranca", () => ({ useRefetchDeSeguranca: () => ({}) }));
vi.mock("@/lib/api/client", () => ({ apiClient: { get: (url: string) => fakes.get(url) } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: () => undefined }));

import { useConversationsRealtime } from "./useConversationsRealtime";
import { useConversation } from "./useConversation";

const FILTROS = {};
const lista = () => fakes.get.mock.calls.filter(([u]) => String(u).startsWith("/api/v1/conversations?")).length;
const aberta = () => fakes.get.mock.calls.filter(([u]) => u === "/api/v1/conversations/c1").length;
const paginasNoCache = (qc: QueryClient) =>
  ((qc.getQueryData(["conversations", FILTROS]) as { pages?: unknown[] } | undefined)?.pages ?? [])
    .length;
const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * O `waitFor` do vitest espera 1 s por padrão — menos que a janela de
 * agrupamento (1,5 s, #4325 item 5). Quem espera a recarga agrupada precisa
 * desta folga, senão o teste reprova por cronômetro, não por defeito.
 */
const ESPERA_DA_JANELA = { timeout: 5000 };

function montar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  renderHook(
    () => {
      useConversationsRealtime(FILTROS, "org-1");
      useConversation("c1", true);
    },
    { wrapper },
  );
  return qc;
}

describe("recarga do inbox pedida pelo realtime", () => {
  beforeEach(() => {
    fakes.get.mockReset();
    // `has_more` sempre verdadeiro: é o que mantém as páginas já carregadas no
    // cache quando a query é refeita. Com `has_more: false` o react-query
    // truncaria a lista na primeira página e a recarga custaria 1 GET nos dois
    // mundos — o teste mediria o mock, não o corte.
    fakes.get.mockImplementation(async (url: string) =>
      url.startsWith("/api/v1/conversations?")
        ? { data: [], meta: { has_more: true, cursor: "proximo" } }
        : { data: { id: "c1" } },
    );
  });

  it("uma rajada de eventos vira UMA busca da lista", async () => {
    montar();
    await waitFor(() => expect(lista()).toBe(1));
    for (let i = 0; i < 5; i++) fakes.onChange!({});
    // A janela de agrupamento é 1,5 s (#4325 item 5): esperar menos que isso
    // mediria a janela, não o agrupamento.
    await esperar(1700);
    expect(lista()).toBe(2);
  });

  it("recarrega também a conversa aberta, que nenhum evento alcançava", async () => {
    montar();
    await waitFor(() => expect(aberta()).toBe(1));
    fakes.onChange!({});
    await waitFor(() => expect(aberta()).toBe(2), ESPERA_DA_JANELA);
  });

  it("não cancela a busca em voo: espera ela terminar e recarrega depois", async () => {
    const qc = montar();
    await waitFor(() => expect(lista()).toBe(1));
    let soltar!: () => void;
    fakes.get.mockImplementationOnce(
      () => new Promise((r) => (soltar = () => r({ data: [] }))),
    );
    void qc.invalidateQueries({ queryKey: ["conversations"] });
    await waitFor(() => expect(lista()).toBe(2));
    fakes.onChange!({});
    await esperar(1700);
    expect(lista(), "a busca em voo foi cancelada por uma nova").toBe(2);
    soltar();
    await waitFor(() => expect(lista()).toBe(3), ESPERA_DA_JANELA);
  });

  it("com seis páginas carregadas, o evento refaz UMA página — não seis", async () => {
    // O número que a issue mediu: quem clicou em "Carregar mais" cinco vezes
    // pagava SEIS requisições por evento, porque invalidar uma
    // `useInfiniteQuery` refaz todas as páginas em série.
    const qc = montar();
    await waitFor(() => expect(lista()).toBe(1));
    const paginas = Array.from({ length: 6 }, (_, i) => ({
      data: [{ id: `c${i}` }],
      meta: { has_more: i < 5, cursor: `cur${i}` },
    }));
    qc.setQueryData(["conversations", FILTROS], {
      pages: paginas,
      pageParams: [undefined, "cur1", "cur2", "cur3", "cur4", "cur5"],
    });
    expect(paginasNoCache(qc)).toBe(6);

    fakes.onChange!({});
    await waitFor(() => expect(lista()).toBe(2), ESPERA_DA_JANELA);
    // Folga para as outras cinco páginas aparecerem, se o cache não fosse cortado.
    await esperar(300);

    expect(lista(), "a recarga refez o histórico inteiro").toBe(2);
    expect(paginasNoCache(qc), "o cache ficou com mais de uma página").toBe(1);
  });
});
