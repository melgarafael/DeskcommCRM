/**
 * #5368 — os dois defeitos de texto do lote do Kanban:
 *
 *  1. o toast de "levar para outro funil" dizia "1 levados para FUNIL" (plural
 *     com um negócio só); com dois ou mais, o plural continua;
 *  2. a confirmação de excluir em lote, em espanhol, saía "Eliminar 1 Negocio?"
 *     sem o "¿" de abertura — a frase é montada no catálogo, não no componente.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const toastSuccess = vi.hoisted(() => vi.fn());
const post = vi.hoisted(() => vi.fn());
const idioma = vi.hoisted(() => ({ atual: "pt-BR" as "pt-BR" | "es" }));

vi.mock("sonner", () => ({ toast: { success: toastSuccess, warning: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/api/client", () => ({
  apiClient: { get: vi.fn().mockResolvedValue({ data: [] }), post, patch: vi.fn() },
}));
// O idioma da tela troca por caso: a mesma composição tem de sair em pt-BR e es.
vi.mock("@/hooks/i18n/useT", async () => {
  const { traduzir } = await import("@/lib/i18n/dicionario");
  return { useT: () => (chave: string) => traduzir(chave, idioma.atual) };
});
vi.mock("@/hooks/kanban/useDestinosDeFunil", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useDestinosDeFunil: () => ({
    data: [
      {
        id: "p2",
        name: "Pós-venda",
        stages: [{ id: "s1", name: "Novo", position: 1, is_won: false, is_lost: false }],
      },
    ],
  }),
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useUser: () => ({ id: "u1", is_platform_admin: false }),
  useActiveOrg: () => ({ role: "manager" }),
}));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({ useAssignableMembers: () => ({ data: [] }) }));
vi.mock("@/hooks/kanban/useBulkAction", () => ({
  useBulkAction: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/kanban/useMotivosDePerdaDoFunil", () => ({
  useMotivosDePerdaDoFunil: () => ["preço alto"],
}));
vi.mock("@/hooks/kanban/useUpdateLead", () => ({
  useLoseLead: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

import { BulkActionBar } from "@/components/kanban/BulkActionBar";
import { LevarLoteParaOutroFunilDialog } from "@/components/kanban/LevarLoteParaOutroFunilDialog";

function comCliente(ui: ReactNode) {
  return <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>;
}

beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
});

beforeEach(() => {
  idioma.atual = "pt-BR";
  toastSuccess.mockClear();
  post.mockReset();
  post.mockResolvedValue({ data: { id: "novo" } });
});

async function levando(ids: string[]) {
  const user = userEvent.setup();
  render(
    comCliente(
      <LevarLoteParaOutroFunilDialog open onOpenChange={vi.fn()} pipelineId="p1" leadIds={ids} />,
    ),
  );
  await user.click(screen.getByRole("combobox", { name: "Funil de destino" }));
  await user.click(await screen.findByRole("option", { name: "Pós-venda" }));
  await user.click(screen.getByRole("button", { name: "Levar" }));
  await screen.findByTestId("resultado-do-lote");
}

describe("#5368 — toast do lote concorda com a contagem", () => {
  it("um negócio: '1 levado para FUNIL', nunca o plural", async () => {
    await levando(["a"]);

    expect(toastSuccess).toHaveBeenCalledWith("1 levado para Pós-venda");
  });

  it("dois negócios continuam no plural: '2 levados para FUNIL'", async () => {
    await levando(["a", "b"]);

    expect(toastSuccess).toHaveBeenCalledWith("2 levados para Pós-venda");
  });
});

describe("#5368 — confirmação de excluir em lote em espanhol", () => {
  it("o título começa com '¿' e nomeia o negócio no singular", async () => {
    idioma.atual = "es";
    const user = userEvent.setup();
    render(
      <BulkActionBar
        selectedIds={["lead-1"]}
        stages={[] as never}
        pipelineId="p-1"
        tagsExistentes={[]}
        onClear={vi.fn()}
        vocabulary={null}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Eliminar" }));

    const titulo = await screen.findByText("¿Eliminar 1 Negocio?");
    expect(titulo.textContent?.startsWith("¿")).toBe(true);
  });
});
