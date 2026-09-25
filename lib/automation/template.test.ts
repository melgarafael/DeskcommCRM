import { describe, it, expect } from "vitest";
import { renderTemplate } from "@/lib/automation/template";

const ctx = {
  contact: { name: "Ana" },
  lead: { title: "Pedido X", custom_fields: { cupom: "BF10" } },
};

describe("renderTemplate", () => {
  it("variável simples", () => expect(renderTemplate("Oi {{contact.name}}!", ctx)).toBe("Oi Ana!"));
  it("path aninhado", () =>
    expect(renderTemplate("Use {{lead.custom_fields.cupom}}", ctx)).toBe("Use BF10"));
  it("alias {{nome}} resolve contact.name", () =>
    expect(renderTemplate("Oi {{nome}}", ctx)).toBe("Oi Ana"));
  it("variável ausente vira vazio, não '{{...}}' cru", () =>
    expect(renderTemplate("X{{lead.ghost}}Y", ctx)).toBe("XY"));
  it("espaços dentro das chaves tolerados", () =>
    expect(renderTemplate("Oi {{ contact.name }}", ctx)).toBe("Oi Ana"));
  it("{{primeiro_nome}} é a primeira palavra do nome, como no Inbox (#1616)", () =>
    expect(
      renderTemplate("Olá, {{primeiro_nome}}!", { contact: { name: "  Maria  Souza " } }),
    ).toBe("Olá, Maria!"));
  it("{{primeiro_nome}} sem contato vira vazio, para a lacuna continuar visível", () => {
    expect(renderTemplate("Olá, {{primeiro_nome}}!", {})).toBe("Olá, !");
    expect(renderTemplate("{{primeiro_nome}}", { contact: { name: null } })).toBe("");
  });
});
