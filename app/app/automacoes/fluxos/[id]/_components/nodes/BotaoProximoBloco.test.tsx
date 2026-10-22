/**
 * O "+" do ManyChat (Automações, out/2026): cada saída do cartão oferece o
 * próximo bloco. A propriedade guardada aqui é de marcação — um "+" por saída,
 * dizendo de qual saída sai — e que ele só existe dentro do editor (com o
 * provedor do mapa); a criação e a ligação da seta são do mapa (`FlowCanvas`).
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AcoesDoMapaContext, type AcoesDoMapa } from "../AcoesDoMapa";
import type { EtapasDoFluxo } from "../EtapasDoFluxo";
import { NodeCard } from "./NodeCard";
import { NODE_VISUALS } from "./nodeVisuals";

const etapasDoFluxo: EtapasDoFluxo = { etapas: [], carregando: false, falhou: false, nomes: {} };
vi.mock("../EtapasDoFluxo", () => ({ useEtapasDoFluxo: () => etapasDoFluxo }));
vi.mock("@xyflow/react", () => ({
  Handle: () => null,
  Position: { Top: "top", Right: "right", Bottom: "bottom", Left: "left" },
}));

const acoes: AcoesDoMapa = {
  adicionarDepois: vi.fn(),
  tipos: [NODE_VISUALS.action, NODE_VISUALS.distribute],
  editarNota: vi.fn(),
  removerNota: vi.fn(),
};

const ramos = [
  { id: "assigned", label: "Distribuído", check: null, kind: "match" as const, condition: { type: "branch" as const, branch_id: "assigned" } },
  { id: "else", label: "Ninguém disponível", check: null, kind: "fallback" as const, condition: { type: "always" as const } },
];

describe("BotaoProximoBloco — o + de cada saída", () => {
  it("no editor, cada saída do cartão tem o seu +, que diz de qual saída sai", () => {
    render(
      <AcoesDoMapaContext.Provider value={acoes}>
        <NodeCard id="d1" visual={NODE_VISUALS.distribute} label="Distribuir" subtitle="3 pessoa(s)" branches={ramos} />
      </AcoesDoMapaContext.Provider>,
    );
    expect(screen.getByTestId("proximo-bloco-d1-assigned").getAttribute("aria-label")).toContain("Distribuído");
    expect(screen.getByTestId("proximo-bloco-d1-else").getAttribute("aria-label")).toContain("Ninguém disponível");
  });

  it("bloco de saída única tem um + só, embaixo", () => {
    render(
      <AcoesDoMapaContext.Provider value={acoes}>
        <NodeCard id="a1" visual={NODE_VISUALS.action} label="Mensagem" subtitle="Olá!" />
      </AcoesDoMapaContext.Provider>,
    );
    expect(screen.getByTestId("proximo-bloco-a1-unica")).toBeTruthy();
  });

  it("fora do editor (sem o mapa), o cartão não oferece + nenhum", () => {
    render(<NodeCard id="d1" visual={NODE_VISUALS.distribute} label="Distribuir" subtitle="x" branches={ramos} />);
    expect(screen.queryByTestId("proximo-bloco-d1-assigned")).toBeNull();
  });
});
