/**
 * AGENTE › GUARDRAILS: CAMPOS DA REGRA POR REGEX TRADUZIDOS (#5211).
 *
 * Nas regras "Bloqueio de saída por regex" e "Bloqueio de entrada por regex",
 * os rótulos "Pattern (regex)" e "Flags" estavam direto no JSX, em inglês,
 * com a tela em português ou em espanhol. O campo de fuso ao lado já foi
 * traduzido (#4818).
 */
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

import { GuardrailsEditor } from "@/components/ai/GuardrailsEditor";
import type { GuardrailItem } from "@/lib/ai/guardrails-schema";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";

const saida: GuardrailItem = {
  kind: "regex_output_block",
  pattern: "",
  flags: "i",
  reason: "teste",
};

const entrada: GuardrailItem = {
  kind: "regex_input_block",
  pattern: "",
  flags: "i",
  reason: "teste",
};

function renderComIdioma(locale: "pt-BR" | "es", item: GuardrailItem) {
  return render(
    createElement(IdiomaProvider, {
      locale,
      children: <GuardrailsEditor value={[item]} onChange={vi.fn()} />,
    }),
  );
}

afterEach(cleanup);

describe("Agente › Guardrails: campos da regra por regex traduzidos", () => {
  for (const item of [saida, entrada]) {
    describe(item.kind, () => {
      it("em português, os campos se chamam Padrão (regex) e Opções da regex", () => {
        renderComIdioma("pt-BR", item);
        expect(screen.getByText("Padrão (regex)")).toBeInTheDocument();
        expect(screen.getByText("Opções da regex")).toBeInTheDocument();
        expect(screen.queryByText("Pattern (regex)")).toBeNull();
        expect(screen.queryByText("Flags")).toBeNull();
      });

      it("em espanhol, os campos se chamam Patrón (regex) e Opciones de la regex", () => {
        renderComIdioma("es", item);
        expect(screen.getByText("Patrón (regex)")).toBeInTheDocument();
        expect(screen.getByText("Opciones de la regex")).toBeInTheDocument();
        expect(screen.queryByText("Pattern (regex)")).toBeNull();
        expect(screen.queryByText("Flags")).toBeNull();
      });
    });
  }
});
