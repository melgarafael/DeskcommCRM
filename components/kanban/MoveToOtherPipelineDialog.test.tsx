import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MoveToOtherPipelineDialog } from "@/components/kanban/MoveToOtherPipelineDialog";

// Polyfills que o Radix Select exige e o jsdom não tem (mesmo padrão de
// app/app/settings/tenant/pipelines/_stages.test.tsx).
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
window.HTMLElement.prototype.setPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const get = vi.hoisted(() => vi.fn());
const post = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api/client", () => ({ apiClient: { get, post, patch: vi.fn() } }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));

const LEAD_ID = "l-1";
const PIPELINE_ID = "p-origem";

function renderDialog(onOpenChange = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    onOpenChange,
    ...render(
      <QueryClientProvider client={client}>
        <MoveToOtherPipelineDialog
          open
          onOpenChange={onOpenChange}
          leadId={LEAD_ID}
          pipelineId={PIPELINE_ID}
        />
      </QueryClientProvider>,
    ),
  };
}

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  get.mockResolvedValue({
    data: { pipelines: [{ id: "p-destino-1", name: "Suporte" }, { id: "p-destino-2", name: "Cobrança" }] },
  });
  post.mockResolvedValue({ data: { lead: { id: "clone-1" }, origem: { id: LEAD_ID, status: "lost" } } });
});

describe("MoveToOtherPipelineDialog", () => {
  it("busca os destinos em /clone (GET) e lista os funis — sem o de origem, que a rota já exclui", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(await screen.findByRole("combobox", { name: "Funil de destino" }));
    expect(await screen.findByRole("option", { name: "Suporte" })).toBeTruthy();
    expect(await screen.findByRole("option", { name: "Cobrança" })).toBeTruthy();
    expect(get).toHaveBeenCalledWith(`/api/v1/leads/${LEAD_ID}/clone`);
  });

  it("confirmar sem escolher destino não envia nada — botão fica desabilitado", () => {
    renderDialog();
    expect(screen.getByRole("button", { name: "Confirmar" })).toBeDisabled();
    expect(post).not.toHaveBeenCalled();
  });

  it("escolhe o destino e confirma: chama POST /clone com o pipeline_id certo, e fecha", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderDialog(onOpenChange);

    await user.click(await screen.findByRole("combobox", { name: "Funil de destino" }));
    await user.click(await screen.findByRole("option", { name: "Suporte" }));
    await user.click(screen.getByRole("button", { name: "Confirmar" }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(`/api/v1/leads/${LEAD_ID}/clone`, {
        pipeline_id: "p-destino-1",
      }),
    );
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("cancelar fecha sem chamar a API", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderDialog(onOpenChange);

    await user.click(screen.getByRole("button", { name: "Cancelar" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(post).not.toHaveBeenCalled();
  });
});
