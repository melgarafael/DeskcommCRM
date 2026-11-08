/**
 * #3974 — "quando o cliente responder, mover o card para a etapa X" NA TELA.
 *
 * O gatilho de ETAPA ganha, ao lado de "cancelar ao responder", um seletor com
 * as etapas do MESMO funil da etapa que dispara. O que se mede aqui é o CONTRATO
 * da tela: o controle existe no gatilho certo, não invade os outros tipos, o
 * padrão é "não mover" (nada gravado) e o que sai no PATCH é exatamente o campo
 * que o motor lê (`move_to_stage_on_reply`).
 *
 * ⚠️ jsdom não tem layout: sobreposição, dobra e foco real não são medidos aqui
 * — isso é DoD de navegador de verdade.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type * as ModuloDeEtapas from "@/hooks/followup/useEtapasDeGatilho";
import type { EtapaDeGatilho } from "@/hooks/followup/useEtapasDeGatilho";

const getMock = vi.fn();
const patchMock = vi.fn();
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: (...a: unknown[]) => getMock(...a),
    patch: (...a: unknown[]) => patchMock(...a),
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));

/** As etapas vêm do hook, não da rede: o que se mede é a tela, não o fetch. */
let etapasDoGatilho: EtapaDeGatilho[] = [];
vi.mock("@/hooks/followup/useEtapasDeGatilho", async (importOriginal) => {
  const real = await importOriginal<typeof ModuloDeEtapas>();
  return { ...real, useEtapasDeGatilho: () => ({ etapas: etapasDoGatilho, carregando: false, falhou: false }) };
});

import { TriggerConfigControl } from "./TriggerConfigControl";

beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
});

/** `delay: null` — sem isso o Radix Select estoura o teto do vitest sob carga. */
const usuario = () => userEvent.setup({ delay: null });

const FLUXO = "66666666-6666-4666-8666-666666666666";
const ORCAMENTO = "aaaaaaaa-1111-4111-8111-111111111111";
const NEGOCIACAO = "bbbbbbbb-2222-4222-8222-222222222222";
const ETAPA_DE_OUTRO_FUNIL = "cccccccc-3333-4333-8333-333333333333";

const ETAPAS: EtapaDeGatilho[] = [
  { stageId: ORCAMENTO, stageName: "Orçamento enviado", pipelineId: "funil-1", pipelineName: "Vendas", isPerda: false, settingsDoFunil: null },
  { stageId: NEGOCIACAO, stageName: "Negociação", pipelineId: "funil-1", pipelineName: "Vendas", isPerda: false, settingsDoFunil: null },
  { stageId: ETAPA_DE_OUTRO_FUNIL, stageName: "Triagem", pipelineId: "funil-2", pipelineName: "Suporte", isPerda: false, settingsDoFunil: null },
];

/** O gatilho de etapa salvo, sem a opção nova — o estado de hoje em produção. */
const GATILHO_DE_ETAPA = { kind: "stage_change", params: { stage_id: ORCAMENTO } };
const GATILHO_DE_SILENCIO = { kind: "silence", params: { threshold_minutes: 180 } };

function montar(triggerConfig: Record<string, unknown>) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } } })}>
      <TriggerConfigControl flowId={FLUXO} triggerConfig={triggerConfig} />
    </QueryClientProvider>,
  );
}

async function abrirPainel(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId("trigger-config-button"));
  return screen.getByTestId("trigger-config-panel");
}

function corpoDoPatch(): Record<string, unknown> {
  expect(patchMock).toHaveBeenCalledTimes(1);
  const [, body] = patchMock.mock.calls[0]!;
  return (body as { trigger_config: Record<string, unknown> }).trigger_config;
}

beforeEach(() => {
  vi.clearAllMocks();
  etapasDoGatilho = ETAPAS;
  getMock.mockResolvedValue({ data: [] });
  patchMock.mockResolvedValue({ data: { id: FLUXO } });
});

describe("a opção «quando o cliente responder, mover o card» (#3974)", () => {
  it("aparece no gatilho de etapa, com rótulo legível, ao lado de cancelar ao responder", async () => {
    const user = usuario();
    montar(GATILHO_DE_ETAPA);
    await abrirPainel(user);

    expect(screen.getByLabelText("Quando o cliente responder, mover o card para")).toBeInTheDocument();
    // A opção antiga continua na mesma janela.
    expect(screen.getByLabelText("Cancelar se o lead responder")).toBeInTheDocument();
  });

  it("nasce em «não mover»: o gatilho de hoje não ganha comportamento novo ao ser reaberto", async () => {
    const user = usuario();
    montar(GATILHO_DE_ETAPA);
    await abrirPainel(user);

    expect(screen.getByTestId("trigger-move-on-reply")).toHaveTextContent("Não mover o card");
  });

  it("escolher a etapa e salvar grava `move_to_stage_on_reply` no gatilho", async () => {
    const user = usuario();
    montar(GATILHO_DE_ETAPA);
    await abrirPainel(user);

    await user.click(screen.getByTestId("trigger-move-on-reply"));
    await user.click(await screen.findByRole("option", { name: /Negociação/ }));
    await user.click(screen.getByTestId("trigger-config-save"));

    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(1));
    const trigger = corpoDoPatch();
    expect(trigger).toMatchObject({
      kind: "stage_change",
      params: { stage_id: ORCAMENTO },
      move_to_stage_on_reply: NEGOCIACAO,
    });
  });

  it("salvar sem escolher etapa NÃO grava a chave — o motor lê o ausente como «não move»", async () => {
    const user = usuario();
    montar(GATILHO_DE_ETAPA);
    await abrirPainel(user);

    // Mexe em outra coisa para o «Salvar» habilitar.
    await user.click(screen.getByLabelText("Cancelar se o lead responder"));
    await user.click(screen.getByTestId("trigger-config-save"));

    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(1));
    expect(corpoDoPatch()).not.toHaveProperty("move_to_stage_on_reply");
  });

  it("só oferece etapas do MESMO funil da etapa que dispara (mover entre funis é recusado)", async () => {
    const user = usuario();
    montar(GATILHO_DE_ETAPA);
    await abrirPainel(user);

    await user.click(screen.getByTestId("trigger-move-on-reply"));

    expect(await screen.findByRole("option", { name: /Negociação/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Triagem/ })).toBeNull();
  });

  it("não aparece no gatilho de silêncio, que não conhece card nenhum", async () => {
    const user = usuario();
    montar(GATILHO_DE_SILENCIO);
    await abrirPainel(user);

    expect(screen.queryByTestId("trigger-move-on-reply")).toBeNull();
  });
});
