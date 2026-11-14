/**
 * #4587 — O FILTRO DO GATILHO «LEAD CRIADO»: FUNIL E ETIQUETA NA TELA.
 *
 * O que se mede aqui é o CONTRATO da tela: os dois controles aparecem só no
 * gatilho de card, o padrão é «qualquer funil / qualquer etiqueta» (nada
 * gravado), o que sai no PATCH é exatamente o que o motor lê
 * (`params.pipeline_id` e `params.tag`, a etiqueta normalizada) e o botão
 * fechado conta o que está escolhido.
 *
 * ⚠️ O COMPORTAMENTO do motor não se mede aqui: quem mede é
 * `lib/followup/gatilho-lead.test.ts` (os quatro lados do filtro).
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

/** As etapas/funis vêm do hook: o que se mede é a tela, não o fetch. */
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
const ETAPA_DE_VENDAS = "aaaaaaaa-1111-4111-8111-111111111111";
const FUNIL_DE_VENDAS = "b1000000-0000-4000-8000-000000000001";
const FUNIL_DE_SUPORTE = "b1000000-0000-4000-8000-000000000002";

const ETAPAS: EtapaDeGatilho[] = [
  { stageId: ETAPA_DE_VENDAS, stageName: "Novo", pipelineId: FUNIL_DE_VENDAS, pipelineName: "Vendas", isPerda: false, settingsDoFunil: null },
  { stageId: "cccccccc-3333-4333-8333-333333333333", stageName: "Novo", pipelineId: FUNIL_DE_SUPORTE, pipelineName: "Suporte", isPerda: false, settingsDoFunil: null },
];

/** O gatilho como ele está hoje em produção: sem filtro nenhum. */
const GATILHO_DE_CARD = { kind: "lead_created" };

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

describe("o filtro do gatilho «Lead criado» (#4587)", () => {
  it("oferece funil e etiqueta no gatilho de card, com o padrão «qualquer»", async () => {
    const user = usuario();
    montar(GATILHO_DE_CARD);
    await abrirPainel(user);

    expect(screen.getByTestId("trigger-lead-pipeline")).toHaveTextContent("Qualquer funil");
    expect(screen.getByTestId("trigger-lead-tag")).toHaveValue("");
  });

  it("escolher funil e etiqueta grava os dois no trigger_config", async () => {
    const user = usuario();
    montar(GATILHO_DE_CARD);
    await abrirPainel(user);

    await user.click(screen.getByTestId("trigger-lead-pipeline"));
    await user.click(await screen.findByRole("option", { name: "Vendas" }));
    await user.type(screen.getByTestId("trigger-lead-tag"), "  VIP ");
    await user.click(screen.getByTestId("trigger-config-save"));

    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(1));
    expect(corpoDoPatch()).toMatchObject({
      kind: "lead_created",
      params: { pipeline_id: FUNIL_DE_VENDAS, tag: "vip" },
    });
  });

  it("salvar SEM filtro não grava `params` — o fluxo de hoje não muda", async () => {
    const user = usuario();
    montar(GATILHO_DE_CARD);
    await abrirPainel(user);

    // Mexe no interruptor que já existia, só para o «Salvar» habilitar.
    await user.click(screen.getByLabelText("Cancelar se o lead responder"));
    await user.click(screen.getByTestId("trigger-config-save"));

    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(1));
    const trigger = corpoDoPatch();
    expect(trigger.kind).toBe("lead_created");
    expect(trigger).not.toHaveProperty("params");
  });

  it("reabrir um fluxo com filtro mostra o que está escolhido, sem uuid na tela", async () => {
    const user = usuario();
    montar({ kind: "lead_created", params: { pipeline_id: FUNIL_DE_VENDAS, tag: "vip" } });

    const botao = screen.getByTestId("trigger-config-button");
    expect(botao).toHaveTextContent("Vendas");
    expect(botao).toHaveTextContent("vip");
    expect(botao.textContent).not.toContain(FUNIL_DE_VENDAS);

    await abrirPainel(user);
    expect(screen.getByTestId("trigger-lead-pipeline")).toHaveTextContent("Vendas");
    expect(screen.getByTestId("trigger-lead-tag")).toHaveValue("vip");
  });

  it("o controle não invade o gatilho de silêncio, que não tem card", async () => {
    const user = usuario();
    montar({ kind: "silence", params: { threshold_minutes: 180 } });
    await abrirPainel(user);

    expect(screen.queryByTestId("trigger-lead-pipeline")).toBeNull();
    expect(screen.queryByTestId("trigger-lead-tag")).toBeNull();
  });
});
