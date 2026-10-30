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

/**
 * O que `GET /api/v1/leads/[id]/clone` devolve depois da #3643: cada funil de
 * destino vem com as etapas NÃO arquivadas, na ordem do quadro. Ganho e perda
 * vêm marcados (`is_won`/`is_lost`) para a tela não oferecer o que ela não pode
 * receber — quem filtra é `etapasAbertasDoDestino`.
 */
const DESTINOS = [
  {
    id: "p-destino-1",
    name: "Suporte",
    stages: [
      { id: "s-triagem", name: "Triagem", position: 1000, is_won: false, is_lost: false },
      {
        id: "s-negociando",
        name: "Negociando",
        position: 2000,
        is_won: false,
        is_lost: false,
      },
      { id: "s-ganho", name: "Ganho", position: 3000, is_won: true, is_lost: false },
      { id: "s-perdido", name: "Perdido", position: 4000, is_won: false, is_lost: true },
    ],
  },
  {
    id: "p-destino-2",
    name: "Cobrança",
    stages: [{ id: "s-cobranca", name: "Em aberto", position: 1000, is_won: false, is_lost: false }],
  },
];

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

/** Escolhe o funil no primeiro seletor e devolve o segundo (etapa) já montado. */
async function escolherFunil(user: ReturnType<typeof userEvent.setup>, nome: string) {
  await escolherSoOFunil(user, nome);
  return screen.findByRole("combobox", { name: "Etapa de entrada" });
}

/** Escolhe o funil sem supor que a etapa monta (funil sem etapa aberta não monta). */
async function escolherSoOFunil(user: ReturnType<typeof userEvent.setup>, nome: string) {
  await user.click(await screen.findByRole("combobox", { name: "Funil de destino" }));
  await user.click(await screen.findByRole("option", { name: nome }));
}

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  get.mockResolvedValue({ data: { pipelines: DESTINOS } });
  post.mockResolvedValue({
    data: { lead: { id: "clone-1" }, origem: { id: LEAD_ID, status: "lost" } },
  });
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
    // E a etapa nem existe antes de haver funil: a lista dela é a do funil.
    expect(screen.queryByRole("combobox", { name: "Etapa de entrada" })).toBeNull();
    expect(post).not.toHaveBeenCalled();
  });

  it("sem escolher etapa, o corpo é o de HOJE: só `pipeline_id` (o servidor escolhe a primeira aberta)", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderDialog(onOpenChange);

    await escolherFunil(user, "Suporte");
    await user.click(screen.getByRole("button", { name: "Confirmar" }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(`/api/v1/leads/${LEAD_ID}/clone`, {
        pipeline_id: "p-destino-1",
      }),
    );
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("funil + etapa escolhida: manda o `stage_id` daquela etapa (#3643)", async () => {
    const user = userEvent.setup();
    renderDialog();

    const etapa = await escolherFunil(user, "Suporte");
    await user.click(etapa);
    await user.click(await screen.findByRole("option", { name: "Negociando" }));
    await user.click(screen.getByRole("button", { name: "Confirmar" }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(`/api/v1/leads/${LEAD_ID}/clone`, {
        pipeline_id: "p-destino-1",
        stage_id: "s-negociando",
      }),
    );
  });

  it("o seletor de etapa só oferece etapa ABERTA do funil escolhido — sem ganho e sem perda", async () => {
    const user = userEvent.setup();
    renderDialog();

    const etapa = await escolherFunil(user, "Suporte");
    await user.click(etapa);

    expect((await screen.findAllByRole("option")).map((o) => o.textContent)).toEqual([
      "Triagem",
      "Negociando",
    ]);
    expect(screen.queryByRole("option", { name: "Ganho" })).toBeNull();
    expect(screen.queryByRole("option", { name: "Perdido" })).toBeNull();
  });

  it("trocar de funil LIMPA a etapa escolhida — a etapa é do funil anterior", async () => {
    const user = userEvent.setup();
    renderDialog();

    const etapaDoSuporte = await escolherFunil(user, "Suporte");
    await user.click(etapaDoSuporte);
    await user.click(await screen.findByRole("option", { name: "Negociando" }));
    expect(screen.getByRole("combobox", { name: "Etapa de entrada" }).textContent).toContain(
      "Negociando",
    );

    const etapaDaCobranca = await escolherFunil(user, "Cobrança");
    // Voltou ao padrão: nenhuma etapa escolhida, placeholder no lugar do nome.
    expect(etapaDaCobranca.textContent).toContain("Primeira etapa aberta (padrão)");
    expect(etapaDaCobranca.textContent).not.toContain("Negociando");

    await user.click(screen.getByRole("button", { name: "Confirmar" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(`/api/v1/leads/${LEAD_ID}/clone`, {
        pipeline_id: "p-destino-2",
      }),
    );
  });

  it("funil sem etapa aberta explica na tela e não confirma — em vez de 422 no toast", async () => {
    get.mockResolvedValue({
      data: {
        pipelines: [
          {
            id: "p-so-terminais",
            name: "Só desfechos",
            stages: [
              { id: "s-ganho", name: "Ganho", position: 1000, is_won: true, is_lost: false },
              { id: "s-perdido", name: "Perdido", position: 2000, is_won: false, is_lost: true },
            ],
          },
        ],
      },
    });
    const user = userEvent.setup();
    renderDialog();

    await escolherSoOFunil(user, "Só desfechos");

    expect(
      await screen.findByText(
        "Este funil não tem etapa aberta para receber o negócio. Escolha outro funil.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Etapa de entrada" })).toBeNull();
    expect(screen.getByRole("button", { name: "Confirmar" })).toBeDisabled();
    expect(post).not.toHaveBeenCalled();
  });

  it("sem outro funil (instalação nova), explica em vez de abrir uma lista vazia", async () => {
    get.mockResolvedValue({ data: { pipelines: [] } });
    renderDialog();

    expect(
      await screen.findByText(
        "Este é o único funil. Crie outro funil para poder levar o negócio até ele.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Funil de destino" })).toBeNull();
    expect(screen.getByRole("button", { name: "Confirmar" })).toBeDisabled();
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
