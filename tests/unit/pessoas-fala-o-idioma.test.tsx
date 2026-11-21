/**
 * PESSOAS: A COLUNA "E-MAIL" SEGUE O IDIOMA (#4991).
 *
 * O cabeçalho "E-mail" da lista estava escrito direto no JSX, enquanto "Nome"
 * e "Atualizado" já passavam por `t()`. O caso monta a tela em espanhol e em
 * português e confere o cabeçalho pelo papel de coluna. A lista vem vazia: o
 * que se mede é só o cabeçalho.
 */
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

import { PeopleListClient } from "@/app/app/people/_client";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";

function noIdioma(locale: "pt-BR" | "es") {
  return render(createElement(IdiomaProvider, { locale, children: <PeopleListClient /> }));
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ data: [] }) })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Pessoas › cabeçalho da coluna de e-mail", () => {
  it("em espanhol, a coluna aparece como Correo", async () => {
    noIdioma("es");
    expect(await screen.findByRole("columnheader", { name: "Correo" })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "E-mail" })).toBeNull();
  });

  it("em português, a coluna continua E-mail", async () => {
    noIdioma("pt-BR");
    expect(await screen.findByRole("columnheader", { name: "E-mail" })).toBeInTheDocument();
  });
});
