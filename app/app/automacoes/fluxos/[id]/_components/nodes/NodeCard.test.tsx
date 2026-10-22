/**
 * O card do nó é onde o dono do fluxo lê o que cada saída faz sem abrir nada.
 * Estes casos guardam as duas propriedades que ele perdeu na prática: o texto
 * não pode ser cortado em uma linha só (o valor da regra está no FIM da frase),
 * e uma regra que aponta para uma etapa que não existe precisa se acusar ali —
 * não só quando alguém clica em Publicar.
 *
 * A medida em pixels do corte é da spec de tela (`tests/e2e/followup-cartoes.spec.ts`);
 * aqui a propriedade é de marcação, que é o que o jsdom sabe dizer.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { EtapasDoFluxo } from "../EtapasDoFluxo";
import { NodeCard } from "./NodeCard";
import { NODE_VISUALS } from "./nodeVisuals";

let etapasDoFluxo: EtapasDoFluxo = { etapas: [], carregando: false, falhou: false, nomes: {} };
vi.mock("../EtapasDoFluxo", () => ({ useEtapasDoFluxo: () => etapasDoFluxo }));
vi.mock("@xyflow/react", () => ({
  Handle: () => null,
  Position: { Top: "top", Right: "right", Bottom: "bottom", Left: "left" },
}));

const LONGA = "O desfecho do passo anterior não foi “respondeu com interesse”";

describe("NodeCard — o texto não é cortado em uma linha", () => {
  it("o subtítulo quebra em duas linhas e guarda o texto inteiro no title", () => {
    render(<NodeCard id="c1" visual={NODE_VISUALS.condition} label="Verificar condição" subtitle={LONGA} />);

    const subtitulo = screen.getByTitle(LONGA);
    expect(subtitulo.className).toContain("line-clamp-2");
    expect(subtitulo.className).not.toContain("truncate");
  });

  it("o rótulo da saída também quebra — é onde mora o valor da regra", () => {
    render(
      <NodeCard
        id="c1"
        visual={NODE_VISUALS.condition}
        label="Verificar condição"
        subtitle="2 regras"
        branches={[
          { id: "regra-1", label: LONGA, check: null, kind: "match", condition: { type: "branch", branch_id: "regra-1" } },
          { id: "else", label: "Nenhuma delas", check: null, kind: "fallback", condition: { type: "always" } },
        ]}
      />,
    );

    const linha = screen.getByTestId("node-branch-c1-regra-1");
    expect(linha.querySelector("span.line-clamp-3")).not.toBeNull();
    expect(linha.querySelector("span.truncate")).toBeNull();
  });
});

describe("NodeCard — regra que não aponta para etapa nenhuma se acusa no card", () => {
  const regraDeEtapa = (valor: string) => ({
    id: "regra-1",
    label: null,
    check: { id: "regra-1", field: "lead_stage" as const, op: "eq" as const, value: valor },
    kind: "match" as const,
    condition: { type: "branch" as const, branch_id: "regra-1" },
  });
  const cartao = (valor: string) =>
    render(
      <NodeCard
        id="c1"
        visual={NODE_VISUALS.condition}
        label="Verificar condição"
        subtitle="2 regras"
        branches={[
          regraDeEtapa(valor),
          { id: "else", label: "Nenhuma delas", check: null, kind: "fallback", condition: { type: "always" } },
        ]}
      />,
    );

  it("nome digitado à mão: a saída fica marcada e o title diz o que fazer", () => {
    etapasDoFluxo = { etapas: [], carregando: false, falhou: false, nomes: { etapa: () => null } };
    cartao("PAGO");

    const linha = screen.getByTestId("node-branch-c1-regra-1");
    expect(linha.dataset.regraSemEtapa).toBe("true");
    expect(linha.getAttribute("title")).toContain("escolha a etapa na lista");
  });

  it("etapa existente não acusa nada e aparece pelo nome", () => {
    const ID = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
    etapasDoFluxo = { etapas: [], carregando: false, falhou: false, nomes: { etapa: (id) => (id === ID ? "Pago · Vendas" : null) } };
    cartao(ID);

    const linha = screen.getByTestId("node-branch-c1-regra-1");
    expect(linha.dataset.regraSemEtapa).toBeUndefined();
    expect(linha).toHaveTextContent("O lead está na etapa “Pago · Vendas”");
  });

  it("enquanto as etapas carregam, o card não acusa uma etapa que existe", () => {
    etapasDoFluxo = { etapas: [], carregando: true, falhou: false, nomes: { etapa: () => "…" } };
    cartao("6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b");

    expect(screen.getByTestId("node-branch-c1-regra-1").dataset.regraSemEtapa).toBeUndefined();
  });

  it("leitura das etapas que FALHOU não vira acusação — o cartão não sabe, e não inventa", () => {
    // O provider responde "…" quando a consulta caiu; o cartão só acusa com null.
    etapasDoFluxo = { etapas: [], carregando: false, falhou: true, nomes: { etapa: () => "…" } };
    cartao("6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b");

    const linha = screen.getByTestId("node-branch-c1-regra-1");
    expect(linha.dataset.regraSemEtapa).toBeUndefined();
    expect(linha).not.toHaveTextContent("(não encontrada)");
  });
});
