/**
 * G3-03 — badge de responsável do lead no kanban.
 * Cobre owner humano (nome + iniciais), owner AGENTE (0070: anel + mono +
 * versão no rótulo) e ausência de dono.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { OwnerBadge, ownerInitials } from "./OwnerBadge";

describe("OwnerBadge", () => {
  it("mostra nome e iniciais quando há responsável humano", () => {
    render(<OwnerBadge ownerKind="user" ownerName="Maria Silva" />);
    expect(screen.getByText("Maria Silva")).toBeInTheDocument();
    expect(screen.getByText("MS")).toBeInTheDocument();
    expect(screen.getByLabelText("Responsável: Maria Silva")).toBeInTheDocument();
  });

  it("cai para rótulo genérico quando o nome do owner é desconhecido", () => {
    render(<OwnerBadge ownerKind="user" ownerName={null} />);
    expect(screen.getByText("Responsável")).toBeInTheDocument();
    expect(screen.getByText("?")).toBeInTheDocument();
  });

  it("responsável que saiu da equipe: o nome fica e o rótulo avisa (#4265)", () => {
    render(<OwnerBadge ownerKind="user" ownerName="Maria Silva" foraDaEquipe />);
    expect(screen.getByText("Maria Silva · Fora da equipe")).toBeInTheDocument();
    expect(screen.getByLabelText("Responsável: Maria Silva · Fora da equipe")).toBeInTheDocument();
  });

  it("saiu da equipe sem nome: rótulo genérico + aviso, nunca quebra", () => {
    render(<OwnerBadge ownerKind="user" ownerName={null} foraDaEquipe />);
    expect(screen.getByText("Responsável · Fora da equipe")).toBeInTheDocument();
    expect(screen.getByText("?")).toBeInTheDocument();
  });

  it("mostra 'Sem responsável' quando não há dono", () => {
    render(<OwnerBadge ownerKind={null} ownerName={null} />);
    expect(screen.getByLabelText("Sem responsável")).toBeInTheDocument();
    expect(screen.getByText("Sem responsável")).toBeInTheDocument();
  });

  it("agente: mesmo tamanho do humano, com anel e inicial em mono", () => {
    render(<OwnerBadge ownerKind="ai" ownerName="Agente Beta" agentVersion={3} />);
    const initials = screen.getByText("AB");
    // Par do humano: mesmo diâmetro (h-6 w-6). Distinção é a FORMA, não a cor.
    expect(initials.className).toContain("h-6 w-6");
    expect(initials.className).toContain("font-mono");
    expect(initials.className).toContain("ring-1");
    expect(initials.className).not.toContain("bg-accent-soft");
  });

  it("agente: rótulo acessível traz nome · versão publicada", () => {
    render(<OwnerBadge ownerKind="ai" ownerName="Agente Beta" agentVersion={3} />);
    expect(screen.getByLabelText("Responsável: Agente Beta · v3")).toBeInTheDocument();
    // O nome fica visível no card; a versão vive no tooltip/rótulo.
    expect(screen.getByText("Agente Beta")).toBeInTheDocument();
  });

  it("agente sem versão publicada não inventa 'v'", () => {
    render(<OwnerBadge ownerKind="ai" ownerName="Agente Beta" agentVersion={null} />);
    expect(screen.getByLabelText("Responsável: Agente Beta")).toBeInTheDocument();
  });

  it("nada de emoji ou badge 'AI' no dono agente", () => {
    const { container } = render(
      <OwnerBadge ownerKind="ai" ownerName="Agente Beta" agentVersion={1} />,
    );
    expect(container.textContent ?? "").not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
    expect(container.textContent).not.toContain("AI");
  });

  it("ownerInitials usa primeira e última palavra", () => {
    expect(ownerInitials("Ana")).toBe("AN");
    expect(ownerInitials("Ana Paula Souza")).toBe("AS");
    expect(ownerInitials("   ")).toBe("?");
  });
});
