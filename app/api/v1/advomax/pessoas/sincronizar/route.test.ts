import { describe, expect, it } from "vitest";

import { lotesDeTelefones, prepararClientesAdvomax } from "./route";

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

it("limita cada consulta de telefone para não exceder a URL do Supabase", () => {
  const telefones = Array.from({ length: 121 }, (_, i) => `+550000000${i}`);
  expect(lotesDeTelefones(telefones).map((lote) => lote.length)).toEqual([60, 60, 1]);
  expect(lotesDeTelefones(telefones).flat()).toEqual(telefones);
});
