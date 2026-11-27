/**
 * #5292 — com o perfil em espanhol, a aba do chat no site em Conexões
 * continuava "Chat no site": o rótulo saía fixo do `page.tsx`, sem passar
 * pelo dicionário (o `ConexoesShell` mostra `chat.label` como veio, porque os
 * outros rótulos que vêm do servidor são nomes de marca).
 *
 * O teste renderiza a página de servidor com o `ConexoesShell` de verdade,
 * dentro do `IdiomaProvider`, e confere o nome da aba como a pessoa o vê. Os
 * painéis de cada canal saem do caminho: o que se mede aqui é a barra de abas.
 */
import type { ReactElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  resolveActiveOrg: vi.fn(),
  chatNoSiteLigado: vi.fn(),
}));

vi.mock("@/lib/auth/server", () => ({
  requireAuth: mocks.requireAuth,
  resolveActiveOrg: mocks.resolveActiveOrg,
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: async () => false }));
vi.mock("@/lib/channels/webchat/modulo", () => ({ chatNoSiteLigado: mocks.chatNoSiteLigado }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`redirect:${path}`);
  }),
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams("aba=chat"),
}));
vi.mock("@/components/connections/RedesSociaisClient", () => ({ RedesSociaisClient: () => null }));
vi.mock("@/components/connections/CanalBotClient", () => ({ CanalBotClient: () => null }));
vi.mock("@/components/connections/CanalChatClient", () => ({ CanalChatClient: () => null }));
vi.mock("@/components/connections/CanalGraphParceiroClient", () => ({
  CanalGraphParceiroClient: () => null,
}));
vi.mock("@/components/connections/CanalOficialClient", () => ({ CanalOficialClient: () => null }));
vi.mock("@/components/connections/CanalParceiroClient", () => ({
  CanalParceiroClient: () => null,
}));
vi.mock("@/components/connections/CanalVozClient", () => ({ CanalVozClient: () => null }));
vi.mock("@/components/connections/ConnectionsClient", () => ({ ConnectionsClient: () => null }));
vi.mock("@/components/connections/TemplatesClient", () => ({ TemplatesClient: () => null }));
vi.mock("@/components/connections/TemplatesParceiroClient", () => ({
  TemplatesParceiroClient: () => null,
}));
vi.mock("@/components/connections/TelefoniaClient", () => ({ TelefoniaClient: () => null }));

import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import ConnectionsPage from "./page";

async function renderizarEm(idioma: "pt-BR" | "es") {
  mocks.requireAuth.mockResolvedValue({ is_platform_admin: false, support: null, idioma });
  const pagina = (await ConnectionsPage()) as ReactElement;
  render(<IdiomaProvider locale={idioma}>{pagina}</IdiomaProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveActiveOrg.mockResolvedValue({ orgId: "org-1", role: "admin" });
  mocks.chatNoSiteLigado.mockResolvedValue(true);
});
afterEach(cleanup);

it("com o perfil em espanhol, a aba do chat no site sai em espanhol", async () => {
  await renderizarEm("es");
  expect(screen.getByRole("tab", { name: "Chat en el sitio" })).toBeTruthy();
  expect(screen.queryByRole("tab", { name: "Chat no site" })).toBeNull();
  // Controle: as abas que já passavam por t() continuam em espanhol.
  expect(screen.getByRole("tab", { name: "Redes sociales" })).toBeTruthy();
});

it('em português a aba continua "Chat no site"', async () => {
  await renderizarEm("pt-BR");
  expect(screen.getByRole("tab", { name: "Chat no site" })).toBeTruthy();
});

it("com o chat no site desligado para a organização, a aba nem aparece", async () => {
  mocks.chatNoSiteLigado.mockResolvedValue(false);
  await renderizarEm("es");
  expect(screen.queryByRole("tab", { name: "Chat en el sitio" })).toBeNull();
});
