/**
 * #2103 — o clique em "Grupos" manda `is_group=true`, e o VAZIO explica o que falta.
 *
 * Primeiro elo medido: a tela monta a URL da listagem com `is_group=true`.
 * Segundo: com a lista vazia, o operador só ouve "Nenhuma conversa com esses
 * filtros" — sem dizer que um grupo precisa estar LIGADO em Conexões › Grupos
 * antes de haver qualquer conversa de grupo para listar (spec: "Só entram os
 * grupos escolhidos. O padrão é desligado"). O segundo caso é o vermelho do
 * #2103: some quando o aviso entrar.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "00000000-0000-4000-8000-0000000000aa";

const get = vi.fn(async (url?: string) => {
  const u = url ?? "";
  if (u === "/api/v1/ai/automatico-ativo") return { data: { ativo: false } };
  if (u.startsWith("/api/v1/conversations/counts")) return { data: {} };
  if (u.startsWith("/api/v1/conversations?")) return { data: [], meta: { has_more: false, cursor: null } };
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
  useAuth: () => ({ user: { id: "u-1", role: "admin" }, activeOrg: { orgId: ORG } }),
  usePermission: () => true,
}));
vi.mock("@/hooks/inbox/useMarkAsRead", () => ({ useMarkAsRead: () => undefined }));
vi.mock("@/hooks/inbox/useClaimConversation", () => ({
  useClaimConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useCloseConversation", () => ({
  useCloseConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { InboxLayout } from "@/components/inbox/InboxLayout";

function montar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <InboxLayout />
    </QueryClientProvider>,
  );
}

async function clicarEmGrupos() {
  const botao = await screen.findByRole("button", { name: "Grupos" });
  fireEvent.click(botao);
}

function urlsPedidas(): string[] {
  return get.mock.calls.map((c) => String(c[0]));
}

describe("inbox: o filtro Grupos (#2103)", () => {
  beforeEach(() => {
    get.mockClear();
    window.history.replaceState(null, "", "/app/inbox");
  });

  it("clicar em Grupos manda is_group=true na listagem", async () => {
    montar();
    await clicarEmGrupos();
    await waitFor(() => expect(urlsPedidas().some((u) => u.includes("is_group=true"))).toBe(true));
  });

  it("lista vazia com o filtro Grupos aponta para Conexões › Grupos", async () => {
    montar();
    await clicarEmGrupos();
    // O vazio tem de EXPLICAR por que não há conversa de grupo nenhuma:
    // nenhuma existe até o operador ligar um grupo do número em Conexões › Grupos.
    await screen.findByText(/Nenhuma conversa com esses filtros/);
    await screen.findByText(/Conexões › Grupos/);
  });
});
