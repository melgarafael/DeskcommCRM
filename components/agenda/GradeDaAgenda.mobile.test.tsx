/**
 * A grade da semana no CELULAR mostra um dia por vez.
 *
 * Por que isto tem teste: sete colunas em 360px dão ~44px cada, e a célula de
 * meia hora vira um alvo de ~44x24px. Errar o toque passa a ser o caso comum.
 * Quem marca horário está com o cliente na frente, no celular, com uma mão.
 *
 * O teste não mede pixel (jsdom não faz layout): ele prova a REGRA — quais
 * colunas carregam a classe que as esconde abaixo de `md`, e quais não. A prova
 * visual real é a spec de Playwright em 360px.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { GradeDaAgenda } from "./GradeDaAgenda";

const QUARTA = new Date("2026-09-16T12:00:00-03:00");

function grade(visao: "dia" | "semana") {
  return render(
    <GradeDaAgenda
      visao={visao}
      ancora={QUARTA}
      agora={QUARTA}
      agendamentos={[]}
      pessoas={[]}
    />,
  );
}

function escondeNoCelular(dia: string) {
  const col = screen.getByTestId(`coluna-dia-${dia}`);
  return col.className.includes("max-md:hidden");
}

describe("grade da semana no celular", () => {
  it("mostra só o dia âncora (quarta) e esconde os outros seis da semana", () => {
    grade("semana");

    // a âncora fica
    expect(escondeNoCelular("2026-09-16")).toBe(false);

    // os demais sete-menos-um somem abaixo de md
    for (const outro of [
      "2026-09-13",
      "2026-09-14",
      "2026-09-15",
      "2026-09-17",
      "2026-09-18",
      "2026-09-19",
    ]) {
      expect(escondeNoCelular(outro), `${outro} deveria sumir no celular`).toBe(true);
    }
  });

  it("na visão de dia não esconde nada — já é uma coluna só", () => {
    grade("dia");
    expect(escondeNoCelular("2026-09-16")).toBe(false);
  });

  it("o desktop continua com a semana inteira", () => {
    grade("semana");
    // Todas as sete colunas existem no DOM: o que muda é só a classe de
    // visibilidade. Esconder por desmontagem quebraria a rolagem e o arraste.
    const colunas = screen.getAllByTestId(/^coluna-dia-/);
    expect(colunas).toHaveLength(7);
  });
});
