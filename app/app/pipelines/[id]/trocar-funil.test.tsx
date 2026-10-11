import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { PipelinePageClient } from "./_client";

// Polyfills que o Radix Select exige e o jsdom não tem (mesmo padrão de
// components/kanban/MoveToOtherPipelineDialog.test.tsx).
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
window.HTMLElement.prototype.setPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

/**
 * Troca rápida de funil no cabeçalho do quadro.
 *
 * O `h1` com o nome do funil vira o gatilho de um `Select` quando há mais de
 * um funil vivo: pular de funil sem voltar à lista. Com um funil só, `h1`
 * puro — seletor de uma opção é ruído permanente.
 */

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push }),
  usePathname: () => "/app/pipelines/p-1",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/hooks/kanban/useBoard", () => ({
  useBoard: () => ({
    data: {
      pipeline: { id: "p-1", name: "Vendas", vocabulary: null, settings: null },
      stages: [],
      leads: [],
    },
    isLoading: false,
    error: null,
    pulses: new Map(),
    realtimeStatus: "SUBSCRIBED",
    seguranca: { divergencias: 0, ultimaVerificacao: null },
  }),
}));
vi.mock("@/hooks/kanban/useBulkAction", () => ({
  useBulkAction: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useUser: () => ({ id: "u-1" }),
  useActiveOrg: () => ({ orgId: "org-1", role: "agent" }),
  usePermission: () => false,
}));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({
  useAssignableMembers: () => ({ data: [] }),
}));
vi.mock("@/hooks/kanban/useAssignableAgents", () => ({
  useAssignableAgents: () => ({ data: [] }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/components/kanban/FilterBar", () => ({ FilterBar: () => null }));
vi.mock("@/components/kanban/NewLeadDialog", () => ({ NewLeadDialog: () => null }));
vi.mock("@/components/kanban/KanbanBoard", () => ({ KanbanBoard: () => null }));
vi.mock("@/components/kanban/BulkActionBar", () => ({ BulkActionBar: () => null }));

const FUNIS = [
  { id: "p-1", name: "Vendas" },
  { id: "p-2", name: "Suporte" },
  { id: "p-3", name: "Parcerias" },
];

beforeEach(() => push.mockClear());

describe("troca rápida de funil", () => {
  it("com um funil só, mostra o h1 e nenhum seletor", () => {
    render(
      <PipelinePageClient
        pipelineId="p-1"
        initialName="Vendas"
        role="admin"
        funis={[{ id: "p-1", name: "Vendas" }]}
      />,
    );

    expect(screen.getByRole("heading", { name: "Vendas" })).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("com vários funis, o título vira seletor com os funis vivos", async () => {
    render(
      <PipelinePageClient pipelineId="p-1" initialName="Vendas" role="admin" funis={FUNIS} />,
    );

    // O h1 continua existindo para leitor de tela, escondido do olho.
    expect(screen.getByRole("heading", { name: "Vendas" })).toBeTruthy();

    const seletor = screen.getByRole("combobox", { name: "Trocar de funil: Vendas" });
    await userEvent.click(seletor);

    expect(await screen.findByRole("option", { name: "Vendas" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Suporte" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Parcerias" })).toBeTruthy();
  });

  it("escolher outro funil navega para o quadro dele, sem query string", async () => {
    render(
      <PipelinePageClient pipelineId="p-1" initialName="Vendas" role="admin" funis={FUNIS} />,
    );

    await userEvent.click(screen.getByRole("combobox", { name: "Trocar de funil: Vendas" }));
    await userEvent.click(await screen.findByRole("option", { name: "Suporte" }));

    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith("/app/pipelines/p-2");
  });

  it("escolher o funil atual não navega", async () => {
    render(
      <PipelinePageClient pipelineId="p-1" initialName="Vendas" role="admin" funis={FUNIS} />,
    );

    await userEvent.click(screen.getByRole("combobox", { name: "Trocar de funil: Vendas" }));
    await userEvent.click(await screen.findByRole("option", { name: "Vendas" }));

    expect(push).not.toHaveBeenCalled();
  });
});
