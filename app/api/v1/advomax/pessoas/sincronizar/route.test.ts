import { describe, expect, it } from "vitest";

import { prepararClientesAdvomax } from "./route";

describe("prepararClientesAdvomax", () => {
  it("traz apenas clientes com telefone e normaliza o número para o CRM", () => {
    expect(prepararClientesAdvomax([
      { codigo: 1, nome: "Cliente local", telefone: "(85) 98765-4321", cliente: true },
      { codigo: 2, nome: "Sem telefone", telefone: null, cliente: true },
      { codigo: 3, nome: "Pessoa não cliente", telefone: "85999998888", cliente: false },
      { codigo: 4, nome: "Telefone inválido", telefone: "123", cliente: true },
    ])).toEqual([
      { codigo: 1, nome: "Cliente local", telefone: "+5585987654321", cliente: true },
    ]);
  });
});
