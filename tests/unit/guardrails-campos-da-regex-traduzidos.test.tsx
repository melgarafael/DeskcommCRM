/**
 * AGENTE › GUARDRAILS: CAMPOS DA REGRA POR REGEX TRADUZIDOS (#5211).
 *
 * Na regra de "Bloqueio de saída por regex" (e entrada), os rótulos dos campos
 * "Pattern (regex)" e "Flags" estavam fixos em inglês. Em espanhol devem ser
 * "Patrón (regex)" e "Opciones de la regex", e em português "Padrão (regex)"
 * e "Opções da regex".
 */
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

import { GuardrailsEditor } from "@/components/ai/GuardrailsEditor";
import type { GuardrailItem } from "@/lib/ai/guardrails-schema";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";

const item: GuardrailItem = {
  kind: "regex_output_block",
  pattern: "",
  flags: "i",
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

describe("Agente › Guardrails: campos da regra por regex traduzidos", () => {
  it("em espanhol, os campos se chamam Patrón (regex) e Opciones de la regex", () => {
    renderComIdioma("es");
    expect(screen.getByText("Patrón (regex)")).toBeInTheDocument();
    expect(screen.getByText("Opciones de la regex")).toBeInTheDocument();
    expect(screen.queryByText("Pattern (regex)")).toBeNull();
    expect(screen.queryByText("Flags")).toBeNull();
  });

  it("em português, os campos se chamam Padrão (regex) e Opções da regex", () => {
    renderComIdioma("pt-BR");
    expect(screen.getByText("Padrão (regex)")).toBeInTheDocument();
    expect(screen.getByText("Opções da regex")).toBeInTheDocument();
    expect(screen.queryByText("Pattern (regex)")).toBeNull();
    expect(screen.queryByText("Flags")).toBeNull();
  });
});
