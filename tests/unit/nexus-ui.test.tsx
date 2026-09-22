import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { nexusTokens } from "@/lib/nexus/tokens";
import { NexusLoading } from "@/components/nexus-ui/feedback/NexusLoading";
import { NexusErrorState } from "@/components/nexus-ui/feedback/NexusErrorState";
import { NexusAiBriefing, NexusAiSuggestion } from "@/components/nexus-ui/ai/NexusAi";

describe("nexus tokens", () => {
  it("espelha a densidade do globals.css (linha 56px, toque 44px)", () => {
    expect(nexusTokens.tableRowHeight).toBe(56);
    expect(nexusTokens.touchTargetMin).toBe(44);
    expect(nexusTokens.duration.fast).toBe(120);
    expect(nexusTokens.duration.base).toBe(200);
    expect(nexusTokens.duration.slow).toBe(320);
  });
});

describe("NexusLoading", () => {
  it("expõe role=status para leitor de tela", () => {
    render(<NexusLoading label="Buscando clientes…" />);
    expect(screen.getByRole("status")).toHaveTextContent("Buscando clientes…");
  });
});

describe("NexusErrorState", () => {
  it("oferece tentar de novo e dispara o retry", () => {
    const retry = vi.fn();
    render(<NexusErrorState onRetry={retry} />);
    fireEvent.click(screen.getByRole("button", { name: /tentar novamente/i }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("variante negado usa role=alert sem quebrar", () => {
    render(<NexusErrorState variant="denied" title="Sem permissão" onRetry={() => {}} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Sem permissão");
  });
});

describe("NexusAiBriefing", () => {
  it("nunca inventa dado: sem insights mostra estado neutro", () => {
    render(<NexusAiBriefing insights={[]} />);
    expect(screen.getByText(/sem novidades/i)).toBeInTheDocument();
  });

  it("renderiza insights reais com ação contextual", () => {
    const acao = vi.fn();
    render(
      <NexusAiBriefing
        insights={[
          { id: "1", text: "12 clientes sem comprar no mês", actionLabel: "Ver", onAction: acao },
        ]}
      />,
    );
    expect(screen.getByText(/12 clientes/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Ver" }));
    expect(acao).toHaveBeenCalledTimes(1);
  });
});

describe("NexusAiSuggestion", () => {
  it("exige aprovação explícita (botões aprovar/descartar)", () => {
    const aprovar = vi.fn();
    const descartar = vi.fn();
    render(
      <NexusAiSuggestion text="Olá! Temos novidades." onApprove={aprovar} onDismiss={descartar} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /usar sugestão/i }));
    fireEvent.click(screen.getByRole("button", { name: /descartar/i }));
    expect(aprovar).toHaveBeenCalledTimes(1);
    expect(descartar).toHaveBeenCalledTimes(1);
  });
});
