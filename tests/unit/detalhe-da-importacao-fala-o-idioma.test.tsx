/**
 * O DETALHE DA IMPORTAÇÃO FALA O IDIOMA DA TELA — INCLUSIVE AS COLUNAS DE VÍNCULO.
 *
 * Em Importações › detalhe, a tabela das linhas importadas tinha três títulos escritos crus, em
 * inglês ("Company", "Person", "Contact"), fora de t(): com a tela em português, ao lado de
 * "Status" e "Erro" já traduzidos (issue #4756). O que se cobra: os três passam por t() e saem no
 * idioma da tela, em português e em espanhol.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ImportDetailClient } from "@/app/app/imports/[id]/_client";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";

const LOTE = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  vi.stubGlobal("fetch", async () =>
    new Response(
      JSON.stringify({
        data: {
          batch: { filename: "clientes.csv", status: "completed", successful_rows: 1, conflict_rows: 0, failed_rows: 0 },
          rows: [
            {
              id: "44444444-4444-4444-8444-444444444444",
              row_number: 1,
              status: "ok",
              error: null,
              company_id: "55555555-5555-4555-8555-555555555555",
              person_id: "66666666-6666-4666-8666-666666666666",
              contact_id: "77777777-7777-4777-8777-777777777777",
            },
          ],
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function titulos(locale: "pt-BR" | "es") {
  render(
    <IdiomaProvider locale={locale}>
      <ImportDetailClient id={LOTE} />
    </IdiomaProvider>,
  );
  await screen.findByText("clientes.csv");
  return screen.getAllByRole("columnheader").map((th) => th.textContent);
}

describe("detalhe da importação", () => {
  it("em português: Empresa, Pessoa e Contato", async () => {
    expect(await titulos("pt-BR")).toEqual(["#", "Status", "Erro", "Empresa", "Pessoa", "Contato"]);
  });

  it("em espanhol: as colunas de vínculo traduzidas", async () => {
    const lista = await titulos("es");
    expect(lista.slice(3)).toEqual(["Empresa", "Persona", "Contacto"]);
  });
});
