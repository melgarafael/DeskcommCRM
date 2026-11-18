/**
 * A SEÇÃO "QUAIS SKILLS ELE USA" DO AGENTE (frente F3, migration 9107).
 *
 * `null` = todas é o padrão e o que toda versão antiga tem. Sair do padrão
 * começa com TODAS marcadas — desmarcar a primeira caixa não pode tirar skill
 * nenhuma sozinho. E a skill marcada que deixou de existir volta à tela,
 * sinalizada, com o desmarcar a um clique.
 */
import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { SkillsDoAgente } from "@/app/app/ai/agents/[id]/_components/SkillsDoAgente";

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));

const SKILLS = [
  { name: "agendamento", description: "Marca horário." },
  { name: "objecao-preco", description: "Quando acham caro." },
];

function montar(value: string[] | null) {
  const onChange = vi.fn();
  render(<SkillsDoAgente skills={SKILLS} value={value} onChange={onChange} />);
  return { onChange };
}

describe("SkillsDoAgente", () => {
  it("padrão: 'usar todas' marcado e a lista escondida", () => {
    montar(null);
    expect((screen.getByTestId("skills-todas") as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByTestId("skills-lista")).toBeNull();
  });

  it("desmarcar 'todas' grava a lista com TODAS marcadas, não vazia", () => {
    const { onChange } = montar(null);
    fireEvent.click(screen.getByTestId("skills-todas"));
    expect(onChange).toHaveBeenCalledWith(["agendamento", "objecao-preco"]);
  });

  it("marcar 'todas' de volta grava null", () => {
    const { onChange } = montar(["agendamento"]);
    fireEvent.click(screen.getByTestId("skills-todas"));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("com lista própria, desmarcar uma skill grava a lista sem ela", () => {
    const { onChange } = montar(["agendamento", "objecao-preco"]);
    fireEvent.click(screen.getByTestId("skill-objecao-preco"));
    expect(onChange).toHaveBeenCalledWith(["agendamento"]);
  });

  it("lista vazia é dita na tela: o agente não carrega skill nenhuma", () => {
    montar([]);
    expect(screen.getByTestId("skills-nenhuma-marcada").textContent).toContain("nem as de plataforma");
    // A exceção que o runtime cumpre (`skillsPuxadasPeloRoteiro`): a tela não pode
    // prometer "nenhuma" e o roteiro injetar a skill que ele nomeia.
    expect(screen.getByTestId("skills-nenhuma-marcada").textContent).toContain("roteiro de atendimento");
    expect(screen.getByTestId("skills-lista-propria-aviso").textContent).toContain("roteiro de atendimento");
  });

  it("nome marcado que não existe mais aparece sinalizado e desmarca a um clique", () => {
    const { onChange } = montar(["agendamento", "skill-renomeada"]);
    expect(screen.getByTestId("skill-skill-renomeada-inexistente").textContent).toContain("não existe mais");
    fireEvent.click(screen.getByTestId("skill-skill-renomeada"));
    expect(onChange).toHaveBeenCalledWith(["agendamento"]);
  });
});
