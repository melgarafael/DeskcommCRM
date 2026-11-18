import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { identidadeDoResponsavel, rotuloDoResponsavel } from "./identidade-do-responsavel";

describe("nome ou e-mail, somente na apresentação da agenda", () => {
  it("nome válido tem prioridade e é normalizado, sem expor o e-mail", () => {
    expect(identidadeDoResponsavel("a", { email: "secret@example.test", user_metadata: { full_name: "  Joana  " } }, false))
      .toEqual({ full_name: "Joana", display_label: "Joana" });
  });
  it.each([undefined, null, "", " \t\n ", 42, false, {}, []])("nome inválido %j usa o e-mail do usuário", (full_name) => {
    expect(identidadeDoResponsavel("a", { email: "  joana@example.test  ", user_metadata: { full_name } }, false))
      .toEqual({ full_name: null, display_label: "joana@example.test" });
  });
  it.each([null, "x", 42, []])("metadata inesperado %j não quebra a página", (user_metadata) => {
    expect(identidadeDoResponsavel("a", { email: "a@example.test", user_metadata }, false).display_label).toBe("a@example.test");
  });
  it("ausência e indisponibilidade são estados distintos e não colapsam IDs", () => {
    const a = identidadeDoResponsavel("same-prefix-1", {}, false);
    const b = identidadeDoResponsavel("same-prefix-2", {}, false);
    expect(a.display_label).toBe("Sem nome ou e-mail · BNDS");
    expect(b.display_label).toBe("Sem nome ou e-mail · AGGP");
    expect(a.display_label).not.toBe(b.display_label);
    // O sufixo é HASH do id, não pedaço dele (#3023): nem o id inteiro, nem os
    // oito primeiros caracteres aparecem no rótulo da agenda.
    for (const rotulo of [a.display_label, b.display_label]) {
      expect(rotulo).not.toContain("same-prefix");
      expect(rotulo).not.toContain("same-p");
    }
    expect(identidadeDoResponsavel("same-prefix-1", null, true).display_label).toBe("Identidade indisponível · BNDS");
  });
  it("e-mail com tipo inesperado não vira identidade", () => {
    expect(identidadeDoResponsavel("a", { email: {} }, false).display_label).toBe("Sem nome ou e-mail · WI7G");
  });
  it("rótulo legado malformado continua distinguível e admite tradução", () => {
    expect(rotuloDoResponsavel("a", {}, "   ", (s) => s === "Identidade indisponível" ? "Identidad no disponible" : s))
      .toBe("Identidad no disponible · WI7G");
    expect(rotuloDoResponsavel("a", undefined, "  Joana ")).toBe("Joana");
  });
  it("nome válido continua prioritário num DTO inconsistente", () => {
    expect(rotuloDoResponsavel("a", "private@example.test", "  Joana ")).toBe("Joana");
  });
  it("nome semelhante a HTML permanece texto renderizado", () => {
    const label = identidadeDoResponsavel("a", { user_metadata: { full_name: '<img src=x onerror="boom">' } }, false).display_label;
    const html = renderToStaticMarkup(createElement("span", null, label));
    expect(html).toContain("&lt;img"); expect(html).not.toContain("<img");
  });
});
