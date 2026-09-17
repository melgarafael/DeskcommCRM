import { render, screen } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it } from "vitest";

import { GradeDaAgenda } from "@/components/agenda/GradeDaAgenda";
import { IdiomaProvider, useT } from "@/lib/i18n/IdiomaProvider";

/**
 * O que o PR #773 (@xxjjjj) passou a traduzir, provado no idioma que a
 * interface SERVE hoje.
 *
 * O PR trazia estes casos em chinês. O chinês está registrado como
 * `em_construcao` (`lib/i18n/registro.ts`) e não é servido a ninguém, então
 * os mesmos comportamentos são provados em espanhol — e o português é o
 * controle: a frase dele tem de sair idêntica à de antes.
 */

function gradeComFalhaDeCarga(locale: "pt-BR" | "es") {
  return render(
    createElement(IdiomaProvider, {
      locale,
      children: createElement(GradeDaAgenda, {
        visao: "dia",
        ancora: new Date(2026, 8, 14, 12),
        agora: new Date(2026, 8, 14, 8),
        pessoas: [],
        agendamentos: [],
        interacao: { horariosPorDia: {}, motivo: "erro", duracaoMin: 30, onMarcarEm: () => {} },
      }),
    }),
  );
}

describe("o bloco da agenda fala o idioma de quem lê", () => {
  it("em espanhol, a data, a hora e o motivo saem traduzidos", () => {
    gradeComFalhaDeCarga("es");
    const bloco = screen.getByTestId("bloco-2026-09-14-09:00");
    expect(bloco).toBeDisabled();
    expect(bloco.getAttribute("aria-label")).toBe(
      "14 de septiembre a las 09:00 — no pude cargar los horarios",
    );
    expect(bloco.getAttribute("title")).toBe("no pude cargar los horarios");
  });

  it("em português, a frase é a mesma de antes de passar por t()", () => {
    gradeComFalhaDeCarga("pt-BR");
    const bloco = screen.getByTestId("bloco-2026-09-14-09:00");
    expect(bloco.getAttribute("aria-label")).toBe(
      "14 de setembro às 09:00 — não consegui carregar os horários",
    );
    expect(bloco.getAttribute("title")).toBe("não consegui carregar os horários");
  });
});

describe("o atributo lang do documento acompanha o idioma", () => {
  it("troca junto com o provider, e o texto troca junto", () => {
    function BotaoSalvar() {
      const t = useT();
      return createElement("button", null, t("Salvar"));
    }
    const pagina = (locale: "pt-BR" | "es") =>
      createElement(IdiomaProvider, { locale, children: createElement(BotaoSalvar) });

    const { rerender } = render(pagina("es"));
    expect(screen.getByRole("button")).toHaveTextContent("Guardar");
    // Leitor de tela e hifenização leem o `lang`; sem isto, o espanhol era
    // lido com a voz do português.
    expect(document.documentElement.lang).toBe("es");

    rerender(pagina("pt-BR"));
    expect(screen.getByRole("button")).toHaveTextContent("Salvar");
    expect(document.documentElement.lang).toBe("pt-BR");
  });
});
