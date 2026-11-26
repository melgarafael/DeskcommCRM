/**
 * #5292 — o nome da aba "Chat no site" em Conexões não mudava de idioma: o
 * rótulo saía fixo do `page.tsx`, sem passar pelo dicionário.
 *
 * A tela é um `page.tsx` de servidor: os dublês são autenticação, módulos que
 * falam com banco e o `ConexoesShell` (componente de cliente), trocado por um
 * dublê que mostra o rótulo recebido. O que se mede é o nome que o servidor
 * entrega para a aba, em espanhol e em português.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { requireAuthMock, resolveActiveOrgMock } = vi.hoisted(() => ({
  requireAuthMock: vi.fn(),
  resolveActiveOrgMock: vi.fn(),
}));

vi.mock("@/lib/auth/server", () => ({
  requireAuth: requireAuthMock,
  resolveActiveOrg: resolveActiveOrgMock,
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: async () => false }));
vi.mock("@/lib/channels/webchat/modulo", () => ({ chatNoSiteLigado: async () => true }));
vi.mock("@/lib/channels/bot/connect", () => ({ ROTULO_DO_CANAL: "Telegram" }));
vi.mock("@/lib/channels/graph-parceiro/credentials", () => ({
  canalGraphParceiroLigado: () => false,
  GRAPH_PARTNER_LABEL: "Datafy",
}));
vi.mock("@/lib/impersonate/support", () => ({ supportWriteError: () => null }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/components/connections/ConexoesShell", () => ({
  ConexoesShell: ({ chat }: { chat?: { label: string } | null }) => (
    <div data-testid="aba-chat">{chat?.label ?? ""}</div>
  ),
}));

import ConnectionsPage from "./page";

function preparar(idioma: string) {
  requireAuthMock.mockResolvedValue({
    id: "11111111-1111-4111-8111-111111111111",
    idioma,
    is_platform_admin: false,
    support: false,
  });
  resolveActiveOrgMock.mockResolvedValue({
    orgId: "33333333-3333-4333-8333-333333333333",
    role: "admin",
  });
}

describe("#5292 Conexões — o nome da aba do chat no site segue o idioma", () => {
  it("em espanhol, a aba se chama \"Chat en el sitio\"", async () => {
    preparar("es");

    render(await ConnectionsPage());

    expect(screen.getByTestId("aba-chat")).toHaveTextContent("Chat en el sitio");
  });

  it("em português, a aba continua \"Chat no site\"", async () => {
    preparar("pt-BR");

    render(await ConnectionsPage());

    expect(screen.getByTestId("aba-chat")).toHaveTextContent("Chat no site");
  });
});
