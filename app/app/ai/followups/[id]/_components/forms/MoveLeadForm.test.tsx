/**
 * O bloco "mover lead" pede o motivo quando o destino é etapa de perda.
 *
 * Molde: `ConditionForm.test.tsx` (mocka `../EtapasDoFluxo`, sem react-query
 * nem rede; estes testes guardam COMPORTAMENTO — o que desce no onChange).
 * As opções vêm da MESMA fonte da janela "Marcar como perdido"
 * (`opcoesDeMotivoDePerda` + `motivosDoFunil`).
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { EtapasDoFluxo } from "../EtapasDoFluxo";
import { MoveLeadForm } from "./MoveLeadForm";
import type { ConfigOf } from "./shared";

/** As etapas que o construtor enxerga, trocadas por teste — sem react-query nem rede. */
let etapasDoFluxo: EtapasDoFluxo = { etapas: [], carregando: false, falhou: false, nomes: {} };
vi.mock("../EtapasDoFluxo", () => ({ useEtapasDoFluxo: () => etapasDoFluxo }));

beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
});

/** `delay: null` — sem isso o Radix Select estoura o teto do vitest sob carga. */
const usuario = () => userEvent.setup({ delay: null });

const COMUM = "bbbbbbbb-2222-4222-8222-222222222222";
const PERDA = "aaaaaaaa-1111-4111-8111-111111111111";
const PERDA_MESMO_FUNIL = "cccccccc-3333-4333-8333-333333333333";
const PERDA_OUTRO_FUNIL = "dddddddd-4444-4444-8444-444444444444";

function comEtapas() {
  etapasDoFluxo = {
    etapas: [
      { stageId: COMUM, stageName: "Proposta", pipelineId: "p1", pipelineName: "Vendas", isPerda: false, settingsDoFunil: null },
      {
        stageId: PERDA,
        stageName: "Perdido",
        pipelineId: "p1",
        pipelineName: "Vendas",
        isPerda: true,
        settingsDoFunil: { lost_reasons: ["Sem orçamento"] },
      },
      {
        stageId: PERDA_MESMO_FUNIL,
        stageName: "Perdido 2",
        pipelineId: "p1",
        pipelineName: "Vendas",
        isPerda: true,
        settingsDoFunil: { lost_reasons: ["Sem orçamento"] },
      },
      {
        stageId: PERDA_OUTRO_FUNIL,
        stageName: "Perdido",
        pipelineId: "p2",
        pipelineName: "Suporte",
        isPerda: true,
        settingsDoFunil: { lost_reasons: ["Sem verba"] },
      },
    ],
    carregando: false,
    falhou: false,
    nomes: {},
  };
}

function renderizar(config: ConfigOf<"move_lead">) {
  const gravados: ConfigOf<"move_lead">[] = [];
  render(<MoveLeadForm config={config} onChange={(c) => gravados.push(c)} />);
  return gravados;
}

describe("MoveLeadForm — motivo da perda", () => {
  it("etapa comum não mostra o seletor de motivo", () => {
    comEtapas();
    renderizar({ stage_id: COMUM });

    expect(screen.queryByLabelText("Motivo da perda")).toBeNull();
    expect(screen.queryByText("Escolha o motivo da perda.")).toBeNull();
  });

  it("etapa de perda mostra o seletor obrigatório com as opções do funil", async () => {
    comEtapas();
    const user = usuario();
    renderizar({ stage_id: PERDA });

    await user.click(screen.getByRole("combobox", { name: "Motivo da perda" }));
    expect(await screen.findByRole("option", { name: "Sem orçamento" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Outro motivo" })).toBeInTheDocument();
    expect(screen.getByText("Escolha o motivo da perda.")).toBeInTheDocument();
  });

  it("escolher o motivo grava lost_reason no config", async () => {
    comEtapas();
    const user = usuario();
    const gravados = renderizar({ stage_id: PERDA });

    await user.click(screen.getByRole("combobox", { name: "Motivo da perda" }));
    await user.click(await screen.findByRole("option", { name: "Sem orçamento" }));

    expect(gravados.at(-1)).toEqual({ stage_id: PERDA, lost_reason: "Sem orçamento" });
  });

  it("perda com motivo não mostra o erro", () => {
    comEtapas();
    renderizar({ stage_id: PERDA, lost_reason: "Sem orçamento" });

    expect(screen.getByLabelText("Motivo da perda")).toBeInTheDocument();
    expect(screen.queryByText("Escolha o motivo da perda.")).toBeNull();
  });

  it("trocar para etapa comum limpa o lost_reason", async () => {
    comEtapas();
    const user = usuario();
    const gravados = renderizar({ stage_id: PERDA, lost_reason: "Sem orçamento" });

    await user.click(screen.getByRole("combobox", { name: "Etapa de destino" }));
    await user.click(await screen.findByRole("option", { name: "Proposta · Vendas" }));

    expect(gravados.at(-1)).toEqual({ stage_id: COMUM });
  });

  it("perda para perda do mesmo funil mantém o motivo", async () => {
    comEtapas();
    const user = usuario();
    const gravados = renderizar({ stage_id: PERDA, lost_reason: "Sem orçamento" });

    await user.click(screen.getByRole("combobox", { name: "Etapa de destino" }));
    await user.click(await screen.findByRole("option", { name: "Perdido 2 · Vendas" }));

    expect(gravados.at(-1)).toEqual({ stage_id: PERDA_MESMO_FUNIL, lost_reason: "Sem orçamento" });
  });

  it("perda para perda de outro funil descarta o motivo que não está lá", async () => {
    comEtapas();
    const user = usuario();
    const gravados = renderizar({ stage_id: PERDA, lost_reason: "Sem orçamento" });

    await user.click(screen.getByRole("combobox", { name: "Etapa de destino" }));
    await user.click(await screen.findByRole("option", { name: "Perdido · Suporte" }));

    expect(gravados.at(-1)).toEqual({ stage_id: PERDA_OUTRO_FUNIL });
  });

  it("motivo gravado fora das opções mostra o seletor vazio e o erro", () => {
    comEtapas();
    renderizar({ stage_id: PERDA_OUTRO_FUNIL, lost_reason: "Sem orçamento" });

    expect(screen.getByRole("combobox", { name: "Motivo da perda" })).toHaveTextContent("Escolha o motivo");
    expect(screen.getByText("Escolha o motivo da perda.")).toBeInTheDocument();
  });
});
