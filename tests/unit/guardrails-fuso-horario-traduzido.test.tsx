/**
 * AGENTE › GUARDRAILS: CAMPO TIMEZONE TRADUZIDO (#4818).
 *
 * Na regra de "janela de horário", o rótulo do campo de fuso estava como
 * "Timezone" direto no JSX, em inglês. Em espanhol deve ser "Zona horaria"
 * e em português "Fuso horário".
 */
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

import { GuardrailsEditor } from "@/components/ai/GuardrailsEditor";
import type { GuardrailItem } from "@/lib/ai/guardrails-schema";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";

const item: GuardrailItem = {
  kind: "window_check",
  start_hour: 7,
  end_hour: 22,
  timezone: "America/Sao_Paulo",
  reason: "teste",
};

function renderComIdioma(locale: "pt-BR" | "es") {
  return render(
    createElement(IdiomaProvider, {
      locale,
      children: <GuardrailsEditor value={[item]} onChange={vi.fn()} />,
    }),
  );
}

afterEach(cleanup);

describe("Agente › Guardrails: campo Timezone traduzido", () => {
  it("em espanhol, o campo se chama Zona horaria", () => {
    renderComIdioma("es");
    expect(screen.getByText("Zona horaria")).toBeInTheDocument();
    expect(screen.queryByText("Timezone")).toBeNull();
  });

  it("em português, o campo se chama Fuso horário", () => {
    renderComIdioma("pt-BR");
    expect(screen.getByText("Fuso horário")).toBeInTheDocument();
    expect(screen.queryByText("Timezone")).toBeNull();
  });
});
