/**
 * A tela de tokens mostra o token de MÓDULO identificado — sem copiar, sem editar o nome — e mantém o
 * botão de revogar (spec 33, F2, tarefa 6). Revogar um módulo desativa a ativação (a rota faz; a mensagem
 * da tela diz que o módulo foi desativado).
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  tokens: [] as unknown[],
  revoke: vi.fn(),
  toastOk: vi.fn(),
}));

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useTagDeIdioma: () => "pt-BR" }));
vi.mock("sonner", () => ({ toast: { success: h.toastOk, error: vi.fn() } }));
vi.mock("@/hooks/team/useApiTokens", () => ({
  useApiTokens: () => ({ data: { data: h.tokens }, isLoading: false }),
  useCreateApiToken: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRevokeApiToken: () => ({ mutateAsync: h.revoke, isPending: false }),
}));

import { ApiTokensClient } from "@/app/app/settings/api-tokens/_components/ApiTokensClient";

const COMUM = {
  id: "t-comum",
  name: "Worker de import",
  prefix: "dsk_11111111",
  scopes: ["mcp:read"],
  last_used_at: null,
  expires_at: null,
  revoked_at: null,
  created_at: "2026-11-01T00:00:00Z",
  extension_installation_id: null,
  module_slug: null,
};
const MODULO = {
  ...COMUM,
  id: "t-modulo",
  name: "Módulo acme/comanda",
  prefix: "dsk_22222222",
  scopes: ["mcp:read", "role:viewer", "actor:module:acme/comanda"],
  extension_installation_id: "i-1",
  module_slug: "acme/comanda",
};

beforeEach(() => {
  vi.clearAllMocks();
  h.tokens = [COMUM, MODULO];
});
afterEach(cleanup);

describe("lista de tokens com token de módulo", () => {
  it("identifica o módulo com o slug e o selo", () => {
    render(<ApiTokensClient />);
    const linha = screen.getByText(/acme\/comanda/, { selector: "span[data-token-de-modulo]" });
    expect(linha.textContent).toContain("Módulo");
    expect(within(linha).getByText("Módulo conectado")).toBeTruthy();
  });

  it("token comum não ganha o selo", () => {
    h.tokens = [COMUM];
    render(<ApiTokensClient />);
    expect(screen.getByText("Worker de import")).toBeTruthy();
    expect(screen.queryByText("Módulo conectado")).toBeNull();
  });

  it("não oferece copiar nem editar o nome do token de módulo", () => {
    h.tokens = [MODULO];
    render(<ApiTokensClient />);
    expect(screen.queryByText(/copiar/i)).toBeNull();
    expect(screen.queryByText(/editar|renomear/i)).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("mantém o botão de revogar e avisa que o módulo foi desativado", async () => {
    h.tokens = [MODULO];
    h.revoke.mockResolvedValue({ data: { id: "t-modulo", module_deactivated: true } });
    render(<ApiTokensClient />);
    await userEvent.click(screen.getByRole("button", { name: "Revogar" }));
    expect(h.revoke).toHaveBeenCalledWith("t-modulo");
    expect(h.toastOk).toHaveBeenCalledWith("Módulo desativado e token revogado.");
  });

  it("revogar token comum segue com a mensagem de sempre", async () => {
    h.tokens = [COMUM];
    h.revoke.mockResolvedValue({ data: { id: "t-comum", revoked_at: "2026-11-05T00:00:00Z" } });
    render(<ApiTokensClient />);
    await userEvent.click(screen.getByRole("button", { name: "Revogar" }));
    expect(h.toastOk).toHaveBeenCalledWith("Token revogado.");
  });
});
