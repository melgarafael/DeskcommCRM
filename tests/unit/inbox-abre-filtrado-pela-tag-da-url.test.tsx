import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O INBOX ABRE FILTRADO PELA ETIQUETA DA URL (#1891).
 *
 * Cada linha do relatório Por etiqueta leva a `/app/inbox?filter=all&tag=X`.
 * O que este arquivo prende é a outra ponta do link:
 *
 *  · `?tag=` vira o filtro de etiqueta do pedido da lista — sem a leitura no
 *    `InboxLayout`, o link abriria a caixa inteira;
 *  · `?filter=all` abre na aba Todas, que não recorta nada: a linha conta
 *    resolvidas e conversas com dono, e a Fila (a aba padrão) esconde as duas;
 *  · sem `?tag=`, o pedido sai igual ao de antes — a leitura é aditiva.
 */

const get = vi.fn(async (bruta?: string): Promise<unknown> => {
  const url = bruta ?? "";
  if (url.startsWith("/api/v1/conversations?")) return { data: [], meta: { has_more: false } };
  if (url === "/api/v1/ai/automatico-ativo") return { data: { ativo: false } };
  if (url === "/api/v1/conversations/counts") return { data: {} };
  return { data: [] };
});

vi.mock("@/lib/api/client", () => ({ apiClient: { get: (url: string) => get(url) } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("@/lib/supabase/browser", () => ({
  prepareRealtimeAuthentication: vi.fn().mockResolvedValue(undefined),
  createClient: () => ({
    channel: () => ({ on: () => ({ subscribe: () => ({}) }), subscribe: () => ({}) }),
    removeChannel: () => {},
  }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/app/inbox",
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(window.location.search),
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({
    user: { id: "u-1", role: "admin" },
    activeOrg: { orgId: "00000000-0000-4000-8000-0000000000aa" },
  }),
  usePermission: () => true,
}));
vi.mock("@/hooks/inbox/useMarkAsRead", () => ({ useMarkAsRead: () => undefined }));
vi.mock("@/hooks/inbox/useClaimConversation", () => ({
  useClaimConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useCloseConversation", () => ({
  useCloseConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));

/** O filtro vira sonda: ele diz em que aba e com que etiqueta a tela abriu. */
vi.mock("@/components/inbox/InboxFilters", () => ({
  InboxFilters: ({ value }: { value: { tab: string; tag?: string } }) => (
    <div data-testid="filtro">{`${value.tab}|${value.tag ?? "sem-etiqueta"}`}</div>
  ),
}));
vi.mock("@/components/inbox/ConversationList", () => ({ ConversationList: () => null }));
vi.mock("@/components/inbox/CRMSidePanel", () => ({ CRMSidePanel: () => null }));
vi.mock("@/components/inbox/ChatThread", () => ({ ChatThread: () => null }));
vi.mock("@/components/inbox/Composer", () => ({ Composer: () => null }));
vi.mock("@/components/inbox/ConversationHeader", () => ({ ConversationHeader: () => null }));
vi.mock("@/components/inbox/RetentionNotice", () => ({ RetentionNotice: () => null }));
vi.mock("@/components/inbox/InboxKeyboardShortcuts", () => ({
  InboxKeyboardShortcuts: () => null,
}));
vi.mock("@/components/inbox/ShortcutsHelpDialog", () => ({ ShortcutsHelpDialog: () => null }));
vi.mock("@/components/inbox/JanelaFechadaAviso", () => ({ JanelaFechadaAviso: () => null }));

import { InboxLayout } from "@/components/inbox/InboxLayout";

function montar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <InboxLayout />
    </QueryClientProvider>,
  );
}

function pedidosDaLista(): URLSearchParams[] {
  return get.mock.calls
    .map((c) => String(c[0] ?? ""))
    .filter((u) => u.startsWith("/api/v1/conversations?"))
    .map((u) => new URLSearchParams(u.split("?")[1]));
}

describe("inbox aberto pelo link do relatório Por etiqueta", () => {
  beforeEach(() => {
    get.mockClear();
  });

  it("?filter=all&tag=vip abre na aba Todas, sem recorte, pedindo só a etiqueta", async () => {
    window.history.replaceState(null, "", "/app/inbox?filter=all&tag=vip");
    montar();

    expect(screen.getByTestId("filtro")).toHaveTextContent("all|vip");
    await waitFor(() => expect(pedidosDaLista().length).toBeGreaterThan(0));
    for (const qs of pedidosDaLista()) {
      expect(qs.getAll("tag")).toEqual(["vip"]);
      // A aba Todas não recorta: nem o comando da Fila, nem status.
      expect(qs.get("comando")).toBeNull();
      expect(qs.get("status")).toBeNull();
    }
  });

  it("sem ?tag=, o pedido sai sem etiqueta, como antes", async () => {
    window.history.replaceState(null, "", "/app/inbox?filter=all");
    montar();

    expect(screen.getByTestId("filtro")).toHaveTextContent("all|sem-etiqueta");
    await waitFor(() => expect(pedidosDaLista().length).toBeGreaterThan(0));
    for (const qs of pedidosDaLista()) expect(qs.getAll("tag")).toEqual([]);
  });
});
