/**
 * A barra de seleção do quadro não oferece ESCRITA a quem só visualiza (#5232).
 *
 * ─── O defeito, medido pela tela ────────────────────────────────────────────
 *
 * A rota em lote (`app/api/v1/leads/bulk/route.ts`) exige `agent` para TODA
 * ação que não é `assign` — `assign` exige `manager`. Só o "Responsável…" e o
 * "Outro funil…" tinham gate na tela; o `viewer` via "Mover para…" (com as
 * etapas do funil), "Tag…", "Marcar como perdido…" e "Excluir", clicava, e
 * recebia 403. É o controle decorativo que a #5024 já tinha resolvido para uma
 * opção só: parece que o sistema falhou, quando a permissão nunca existiu.
 *
 * ─── Por que um arquivo próprio ─────────────────────────────────────────────
 *
 * `BulkActionBar.test.tsx` já cobre comportamentos demais (D10, perdido em
 * lote, vocabulário, #5024, #5102); a matriz de papéis é uma pergunta
 * diferente — "quem VÊ o quê" —, e aqui ela fica inteira, com os três papéis
 * lado a lado.
 */
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BulkActionBar } from "./BulkActionBar";

const papelDaOrg = vi.hoisted(() => ({ atual: "manager" as "manager" | "agent" | "viewer" }));

vi.mock("@/lib/api/client", () => ({ apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn() } }));
vi.mock("@/hooks/i18n/useT", async () => {
  const { traduzir } = await import("@/lib/i18n/dicionario");
  return { useT: () => (chave: string) => traduzir(chave, "pt-BR") };
});
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useUser: () => ({ id: "u1", is_platform_admin: false }),
  useActiveOrg: () => ({ role: papelDaOrg.atual }),
}));
// O hook do menu "Responsável…" só é consultado com `enabled` verdadeiro; o
// teste do gate de `manager` passa por ele.
const useAssignableMembers = vi.hoisted(() => vi.fn(() => ({ data: [] })));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({ useAssignableMembers }));
vi.mock("@/hooks/kanban/useBulkAction", () => ({
  useBulkAction: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/kanban/useDestinosDeFunil", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useDestinosDeFunil: () => ({ data: [] }),
}));
vi.mock("@/hooks/kanban/useMotivosDePerdaDoFunil", () => ({
  useMotivosDePerdaDoFunil: () => ["preço alto"],
}));
vi.mock("@/hooks/kanban/useUpdateLead", () => ({
  useLoseLead: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() } }));

// Funil COM etapa de perda: sem ela "Marcar como perdido…" não aparece nem para
// quem pode — e o teste do `agent` passaria por omissão errada.
const STAGES_COM_PERDA = [
  { id: "s1", name: "Novo", is_lost: false },
  { id: "s-perdido", name: "Perdido", is_lost: true },
] as never;

function montar() {
  render(
    <BulkActionBar
      selectedIds={["lead-1", "lead-2"]}
      stages={STAGES_COM_PERDA}
      pipelineId="p-1"
      tagsExistentes={["vip"]}
      onClear={vi.fn()}
    />,
  );
}

/** As quatro ações de ESCRITA que a rota só aceita de `agent` para cima. */
const ACOES_DE_ESCRITA = ["Mover para…", "Tag…", "Marcar como perdido…", "Excluir"] as const;

beforeEach(() => {
  papelDaOrg.atual = "manager";
  useAssignableMembers.mockClear();
});

describe("BulkActionBar — quem só visualiza não vê ação de escrita (#5232)", () => {
  it("viewer: nenhuma das quatro ações de escrita aparece", () => {
    papelDaOrg.atual = "viewer";
    montar();

    // A barra EXISTE (a seleção é legítima, e "Cancelar" limpa) — o que some é
    // a escrita.
    expect(screen.getByRole("button", { name: "Cancelar" })).toBeInTheDocument();
    expect(screen.getByText("2 selecionados")).toBeInTheDocument();

    for (const acao of ACOES_DE_ESCRITA) {
      expect(
        screen.queryByRole("button", { name: acao }),
        `"${acao}" não pode ser oferecida a quem a rota recusa com 403`,
      ).not.toBeInTheDocument();
    }
  });

  it("viewer: nem o menu de etapas nem o de tags ficam montados (nada de controle decorativo)", () => {
    papelDaOrg.atual = "viewer";
    montar();

    // Sem os gatilhos, não há menu para abrir: a etapa e a etiqueta existentes
    // não chegam a ser oferecidas.
    expect(screen.queryByRole("button", { name: "Mover para…" })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("nova tag")).not.toBeInTheDocument();
    expect(screen.queryByText("Novo")).not.toBeInTheDocument();
  });

  it("agent: as quatro ações aparecem, e 'Responsável…' (manager) continua escondida", () => {
    papelDaOrg.atual = "agent";
    montar();

    for (const acao of ACOES_DE_ESCRITA) {
      expect(
        screen.getByRole("button", { name: acao }),
        `"${acao}" é escrita de agent`,
      ).toBeInTheDocument();
    }
    expect(screen.queryByRole("button", { name: "Responsável…" })).not.toBeInTheDocument();
    // Sem o menu de atribuição não há por que consultar a lista de atendentes.
    expect(useAssignableMembers).toHaveBeenCalledWith(false);
  });

  it("manager: vê as quatro ações E 'Responsável…'", () => {
    papelDaOrg.atual = "manager";
    montar();

    for (const acao of ACOES_DE_ESCRITA) {
      expect(screen.getByRole("button", { name: acao })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "Responsável…" })).toBeInTheDocument();
    expect(useAssignableMembers).toHaveBeenCalledWith(true);
  });
});
