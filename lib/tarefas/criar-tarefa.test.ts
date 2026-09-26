import { describe, expect, it } from "vitest";

import { interpolarTitulo } from "./criar-tarefa";

/**
 * #1540 — o lembrete interno.
 *
 * O título é a ÚNICA coisa que a pessoa lê antes de agir, e os placeholders são
 * como o operador os escreve na tela. O que este arquivo vigia: os dois
 * placeholders que a proposta nomeia (`{{lead.title}}`, `{{contact.name}}`) e o
 * comportamento diante de dado ausente — apagar seria esconder do operador que
 * falta preencher o campo, e título vazio é linha que o CHECK do banco recusa
 * sem dizer por quê.
 */
describe("interpolarTitulo", () => {
  it("⭐ substitui os dois placeholders da proposta", () => {
    expect(
      interpolarTitulo("Ligar para {{contact.name}} sobre {{lead.title}}", {
        lead: { id: "l1", title: "Renovação do contrato" },
        contact: { id: "c1", name: "Ana Souza" },
      }),
    ).toBe("Ligar para Ana Souza sobre Renovação do contrato");
  });

  it("prefere display_name (o rótulo da tela) e cai para name", () => {
    expect(
      interpolarTitulo("Ligar para {{contact.name}}", {
        contact: { id: "c1", name: "Ana", display_name: "Ana (Jurídico)" },
      }),
    ).toBe("Ligar para Ana (Jurídico)");
    expect(
      interpolarTitulo("Ligar para {{contact.name}}", { contact: { id: "c1", name: "Ana" } }),
    ).toBe("Ligar para Ana");
  });

  it("placeholder sem dado fica À VISTA — não vira título em branco", () => {
    expect(interpolarTitulo("Ligar para {{contact.name}}", { contact: { id: "c1" } })).toBe(
      "Ligar para",
    );
    expect(interpolarTitulo("{{lead.title}}", { lead: { id: "l1", title: " " } })).toBe("");
  });

  it("texto sem placeholder passa adiante intacto", () => {
    expect(interpolarTitulo("Revisar proposta", {})).toBe("Revisar proposta");
  });
});
