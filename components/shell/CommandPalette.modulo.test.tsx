/**
 * O ITEM "Abrir ao lado" DO ⌘K (spec 33, F4, tarefa 5): um por módulo conectado, no grupo
 * "Módulos"; escolher abre o painel (`abrir(slug)`) e NÃO navega; sem módulo nada é acrescentado.
 */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { router, auth, painel } = vi.hoisted(() => ({
  router: { push: vi.fn() },
  auth: { value: {} as Record<string, unknown> },
  painel: { modulos: [] as { slug: string; titulo: string }[], abrir: vi.fn() },
}));

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/hooks/auth/AuthProvider", () => ({ useAuth: () => auth.value }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/components/modulo/PainelDoModulo", () => ({
  usePainelDoModulo: () => ({ modulos: painel.modulos, slugAberto: null, abrir: painel.abrir, fechar: () => {} }),
}));

import { CommandPalette } from "./CommandPalette";

beforeEach(() => {
  router.push.mockReset();
  painel.abrir.mockReset();
  auth.value = {
    user: { is_platform_admin: false, support: null },
    activeOrg: { orgId: "org-1", role: "admin", modulos_ligados: [], capacidades_ligadas: [], modulos_conectados: [] },
  };
});
afterEach(cleanup);

describe("⌘K com módulo conectado", () => {
  it("escolher 'Abrir ao lado' abre o painel e não navega", async () => {
    painel.modulos = [{ slug: "acme-comanda", titulo: "Comanda" }];
    const aoMudar = vi.fn();
    render(<CommandPalette open onOpenChange={aoMudar} />);
    const item = await screen.findByText("Abrir ao lado: Comanda");
    await userEvent.click(item);
    expect(painel.abrir).toHaveBeenCalledWith("acme-comanda");
    expect(router.push).not.toHaveBeenCalled();
    expect(aoMudar).toHaveBeenCalledWith(false);
  });

  it("sem módulo nenhum item 'Abrir ao lado' aparece", () => {
    painel.modulos = [];
    render(<CommandPalette open onOpenChange={() => {}} />);
    expect(screen.queryByText(/Abrir ao lado/)).toBeNull();
  });
});
