import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BulkActionBar } from "./BulkActionBar";

const get = vi.hoisted(() => vi.fn());
const bulkMutate = vi.hoisted(() => vi.fn());
const bulkMutateAsync = vi.hoisted(() => vi.fn());
const toastSuccess = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api/client", () => ({ apiClient: { get, post: vi.fn(), patch: vi.fn() } }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));
vi.mock("sonner", () => ({ toast: { success: toastSuccess, warning: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useUser: () => ({ id: "u1", is_platform_admin: false }),
  useActiveOrg: () => ({ role: "manager" }),
}));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({ useAssignableMembers: () => ({ data: [] }) }));
vi.mock("@/hooks/kanban/useBulkAction", () => ({
  useBulkAction: () => ({ mutate: bulkMutate, mutateAsync: bulkMutateAsync, isPending: false }),
}));
// F2 (#2484): o diálogo de motivo do card, reusado pela barra, exige estes dois.
// Os motivos vêm do FUNIL (é o que a tela tem de mostrar) e a mutação individual
// fica de fora — no lote quem escreve é o `mutateAsync` acima.
vi.mock("@/hooks/kanban/useMotivosDePerdaDoFunil", () => ({
  useMotivosDePerdaDoFunil: () => ["preço alto", "prazo curto"],
}));
vi.mock("@/hooks/kanban/useUpdateLead", () => ({
  useLoseLead: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

// Funil SEM etapa de perda: a barra não tem onde marcar perdido.
const STAGES = [{ id: "s1", name: "Novo" }] as never;
// Funil COM etapa de perda: é sobre ela que o lote fecha os selecionados.
const STAGES_COM_PERDA = [
  { id: "s1", name: "Novo", is_lost: false },
  { id: "s-perdido", name: "Perdido", is_lost: true },
] as never;

describe("BulkActionBar — D10, aviso agregado ao excluir em lote", () => {
  beforeEach(() => {
    get.mockReset();
    get.mockResolvedValue({ data: [] });
    bulkMutate.mockReset();
  });

  it("algum dos negocios selecionados tem proposta enviada: avisa na confirmacao", async () => {
    get.mockImplementation(async (url: string) =>
      url.includes("lead-1") ? { data: [{ status: "enviada" }] } : { data: [] },
    );
    const user = userEvent.setup();
    render(
      <BulkActionBar
        selectedIds={["lead-1", "lead-2"]}
        stages={STAGES}
        pipelineId="p-1"
        tagsExistentes={[]}
        onClear={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Excluir" }));
    await waitFor(() => expect(screen.getByText(/continuam disponíveis em Propostas/i)).toBeInTheDocument());
  });

  it("nenhum negocio selecionado tem proposta enviada: sem aviso extra", async () => {
    get.mockResolvedValue({ data: [] });
    const user = userEvent.setup();
    render(
      <BulkActionBar
        selectedIds={["lead-1", "lead-2"]}
        stages={STAGES}
        pipelineId="p-1"
        tagsExistentes={[]}
        onClear={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Excluir" }));
    await screen.findByText("Esta ação remove o que está selecionado. Não pode ser desfeita.");
    expect(screen.queryByText(/continuam disponíveis em Propostas/i)).not.toBeInTheDocument();
  });
});

describe("BulkActionBar — F2 (#2484): perdido em lote", () => {
  beforeEach(() => {
    get.mockReset();
    get.mockResolvedValue({ data: [] });
    bulkMutate.mockReset();
    bulkMutateAsync.mockReset();
    bulkMutateAsync.mockResolvedValue({ data: { updated_count: 2 } });
    toastSuccess.mockReset();
  });

  function montar(stages = STAGES_COM_PERDA, onClear = vi.fn()) {
    render(
      <BulkActionBar
        selectedIds={["lead-1", "lead-2"]}
        stages={stages}
        pipelineId="p-1"
        tagsExistentes={[]}
        onClear={onClear}
      />,
    );
    return onClear;
  }

  it("seleção → ação → diálogo com os motivos do funil → confirma: a rota leva os ids e o motivo", async () => {
    const onClear = montar();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Marcar como perdido…" }));

    // O MESMO diálogo do card: acha-se pela acessibilidade, não por testid.
    const caixa = await screen.findByRole("dialog");
    // Os motivos do funil — não o padrão do produto (mock devolve o funil).
    expect(within(caixa).getByRole("radio", { name: "preço alto" })).toBeInTheDocument();
    expect(within(caixa).getByRole("radio", { name: "prazo curto" })).toBeInTheDocument();

    await user.click(within(caixa).getByRole("radio", { name: "preço alto" }));
    await user.click(within(caixa).getByRole("button", { name: "Confirmar" }));

    await waitFor(() =>
      expect(bulkMutateAsync).toHaveBeenCalledWith({
        action: "move",
        lead_ids: ["lead-1", "lead-2"],
        params: { stage_id: "s-perdido", lost_reason: "preço alto" },
      }),
    );
    // Um motivo ÚNICO aplicado ao lote inteiro: a chamada leva o motivo escolhido.
    expect(bulkMutateAsync).toHaveBeenCalledTimes(1);
    expect(onClear).toHaveBeenCalled();
    // A confirmação de que deu certo: sem ela o lote some do quadro em silêncio
    // (prova de tela de 14/10 — o "atribuir" em lote já avisava, o "perder" não).
    expect(toastSuccess).toHaveBeenCalledWith("2 marcados como perdidos.");
  });

  it("sem motivo a ação não confirma: nenhuma escrita sai", async () => {
    montar();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Marcar como perdido…" }));
    const caixa = await screen.findByRole("dialog");

    // Sem escolher motivo, o "Confirmar" está barrado — e nada foi escrito.
    expect(within(caixa).getByRole("button", { name: "Confirmar" })).toBeDisabled();
    expect(bulkMutateAsync).not.toHaveBeenCalled();
    expect(bulkMutate).not.toHaveBeenCalled();
  });

  it("funil sem etapa de perda: a ação não é oferecida", () => {
    montar(STAGES);
    expect(screen.queryByRole("button", { name: "Marcar como perdido…" })).not.toBeInTheDocument();
  });
});
