/**
 * AGENTE › GUARDRAILS: TIPOS DE REGRA TRADUZIDOS (#5051).
 *
 * Os quatro rótulos de KIND_LABELS nasciam em inglês. A chave do dicionário
 * agora é o texto em português, como o resto do projeto.
 */
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

import { GuardrailsEditor } from "@/components/ai/GuardrailsEditor";
import type { GuardrailItem } from "@/lib/ai/guardrails-schema";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";

const itens: GuardrailItem[] = [
  { kind: "regex_output_block", pattern: "segredo", flags: "i", reason: "teste" },
  { kind: "rag_must_hit", min_citations: 1, reason: "teste" },
  { kind: "regex_input_block", pattern: "segredo", flags: "i", reason: "teste" },
  { kind: "contact_flag", field: "is_vip", expected: true, reason: "teste" },
];

function renderComIdioma(locale: "pt-BR" | "es") {
  return render(
    createElement(IdiomaProvider, {
      locale,
      children: <GuardrailsEditor value={itens} onChange={vi.fn()} />,
    }),
  );
}

afterEach(cleanup);

describe("Agente › Guardrails: tipos de regra traduzidos", () => {
  it("em português, nenhum dos quatro tipos aparece em inglês", () => {
    renderComIdioma("pt-BR");

    expect(screen.getAllByText("Bloqueio de saída por regex").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Precisa achar no RAG").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Bloqueio de entrada por regex").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Marca do contato").length).toBeGreaterThan(0);

    expect(screen.queryByText("Regex output block")).toBeNull();
    expect(screen.queryByText("RAG must hit")).toBeNull();
    expect(screen.queryByText("Regex input block")).toBeNull();
    expect(screen.queryByText("Contact flag")).toBeNull();
  });

  it("em espanhol, os rótulos continuam os mesmos de antes", () => {
    renderComIdioma("es");

    expect(screen.getAllByText("Bloqueo de salida por regex").length).toBeGreaterThan(0);
    expect(screen.getAllByText("RAG debe coincidir").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Bloqueo de entrada por regex").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Marca de contacto").length).toBeGreaterThan(0);
  });
});
