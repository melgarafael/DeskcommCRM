import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { NexusAiApproval } from "@/components/nexus-ui/ai/NexusAiApproval";
import { NexusAiSources } from "@/components/nexus-ui/ai/NexusAiSources";
import { NexusAiContextMeter } from "@/components/nexus-ui/ai/NexusAiContextMeter";

describe("NexusAiApproval", () => {
  it("aprova e dispensa por gestos distintos, travando os dois em busy", () => {
    const aprovar = vi.fn();
    const dispensar = vi.fn();
    const { rerender } = render(
      <NexusAiApproval
        title="Ligar para o lead"
        description="Sugerir recompra"
        approveAria="Aprovar: Ligar"
        dismissAria="Dispensar: Ligar"
        onApprove={aprovar}
        onDismiss={dispensar}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Aprovar: Ligar" }));
    fireEvent.click(screen.getByRole("button", { name: "Dispensar: Ligar" }));
    expect(aprovar).toHaveBeenCalledTimes(1);
    expect(dispensar).toHaveBeenCalledTimes(1);

    rerender(<NexusAiApproval title="X" onApprove={aprovar} onDismiss={dispensar} busy enabled />);
    expect(screen.getByRole("button", { name: /decidindo/i })).toBeDisabled();
  });

  it("sem papel, os dois desabilitam (nunca aprova sem poder)", () => {
    render(<NexusAiApproval title="X" onApprove={vi.fn()} onDismiss={vi.fn()} enabled={false} />);
    for (const b of screen.getAllByRole("button")) expect(b).toBeDisabled();
  });
});

describe("NexusAiSources", () => {
  it("some sem fontes (ausência de bloco, não bloco vazio)", () => {
    const { container } = render(<NexusAiSources sources={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("lista fontes com detalhe", () => {
    render(
      <NexusAiSources sources={[{ id: "1", label: "Tabela de preços", detail: "12 trechos" }]} />,
    );
    expect(screen.getByText("Tabela de preços")).toBeInTheDocument();
    expect(screen.getByText(/12 trechos/)).toBeInTheDocument();
  });
});

describe("NexusAiContextMeter", () => {
  it("some sem teto (número solto não vira barra)", () => {
    const { container } = render(
      <NexusAiContextMeter label="Custo" used={10} limit={0} format={(v) => `${v}`} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("mostra progresso com acessibilidade", () => {
    render(<NexusAiContextMeter label="Custo" used={80} limit={100} format={(v) => `US$ ${v}`} />);
    expect(screen.getByRole("progressbar", { name: "Custo" })).toHaveAttribute(
      "aria-valuenow",
      "80",
    );
    expect(screen.getByText(/US\$ 80 \/ US\$ 100/)).toBeInTheDocument();
  });
});
