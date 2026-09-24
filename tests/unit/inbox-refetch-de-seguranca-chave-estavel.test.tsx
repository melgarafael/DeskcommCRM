import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { useConversationsRealtime } from "@/hooks/inbox/useConversationsRealtime";
import { useMessagesRealtime } from "@/hooks/inbox/useMessagesRealtime";

/**
 * O refetch de segurança põe a `queryKey` nas dependências do `useCallback`
 * que alimenta o `setInterval`. Uma chave recriada a cada render reinicia o
 * intervalo a cada render, e numa tela que redesenha a verificação nunca roda
 * (#1527). O teste lê a chave que o hook entrega ao refetch em dois renders.
 */
const chaves: (readonly unknown[])[] = [];
vi.mock("@/hooks/realtime/useRefetchDeSeguranca", () => ({
  useRefetchDeSeguranca: ({ queryKey }: { queryKey: readonly unknown[] }) => {
    chaves.push(queryKey);
    return { divergencias: 0, ultimaDivergencia: null, ultimaVerificacao: null };
  },
}));
vi.mock("@/hooks/realtime/useRealtimeChannel", () => ({
  useRealtimeChannel: () => ({ status: "SUBSCRIBED", ultimaEntrega: { current: null } }),
}));
vi.mock("@/lib/api/client", () => ({
  apiClient: { get: () => new Promise(() => {}) },
}));

const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("refetch de segurança do inbox recebe chave estável entre renders", () => {
  it("mensagens", () => {
    chaves.length = 0;
    const { rerender } = renderHook(() => useMessagesRealtime("c-1"), { wrapper });
    rerender();
    expect(chaves.length).toBeGreaterThanOrEqual(2);
    expect(chaves.at(-1)).toBe(chaves[0]);
  });

  it("conversas", () => {
    chaves.length = 0;
    const filtros = { status: "open" as const };
    const { rerender } = renderHook(() => useConversationsRealtime(filtros, "org-1"), { wrapper });
    rerender();
    expect(chaves.length).toBeGreaterThanOrEqual(2);
    expect(chaves.at(-1)).toBe(chaves[0]);
  });
});
