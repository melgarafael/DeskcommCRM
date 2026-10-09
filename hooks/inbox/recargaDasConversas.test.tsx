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
const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    fakes.get.mockImplementation(async (url: string) =>
      url.startsWith("/api/v1/conversations?") ? { data: [] } : { data: { id: "c1" } },
    );
  });

  it("uma rajada de eventos vira UMA busca da lista", async () => {
    montar();
    await waitFor(() => expect(lista()).toBe(1));
    for (let i = 0; i < 5; i++) fakes.onChange!({});
    await esperar(400);
    expect(lista()).toBe(2);
  });

  it("recarrega também a conversa aberta, que nenhum evento alcançava", async () => {
    montar();
    await waitFor(() => expect(aberta()).toBe(1));
    fakes.onChange!({});
    await waitFor(() => expect(aberta()).toBe(2));
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
    await esperar(400);
    expect(lista(), "a busca em voo foi cancelada por uma nova").toBe(2);
    soltar();
    await waitFor(() => expect(lista()).toBe(3));
  });
});
