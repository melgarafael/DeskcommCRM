import { describe, expect, it } from "vitest";
import { pedidoNuvemshopSchema } from "./pedido-nuvemshop";
import { decidirContato, extrairChaves, type ChavesDoContato } from "./contato-do-pedido";

const base = {
  id: 1, total: "1.00", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z",
};

describe("extrairChaves", () => {
  it("prefere os campos contact_* e normaliza", () => {
    const c = extrairChaves(pedidoNuvemshopSchema.parse({
      ...base,
      contact_phone: "(11) 99999-0000",
      contact_email: "  Ana@Ex.COM ",
      contact_identification: "123.456.789-09",
      contact_name: "Ana",
      customer: { phone: "+5521888880000", email: "outra@ex.com", name: "Outra" },
    }));
    expect(c).toEqual({ telefone: "+5511999990000", email: "ana@ex.com", cpf: "12345678909", nome: "Ana" });
  });

  it("cai para customer.* e billing_phone", () => {
    const c = extrairChaves(pedidoNuvemshopSchema.parse({
      ...base,
      customer: { billing_phone: "21988880000", email: "b@ex.com", identification: "98765432100", name: "Bia" },
    }));
    expect(c).toEqual({ telefone: "+5521988880000", email: "b@ex.com", cpf: "98765432100", nome: "Bia" });
  });

  it("telefone estrangeiro com + é preservado (Tiendanube AR)", () => {
    const c = extrairChaves(pedidoNuvemshopSchema.parse({ ...base, contact_phone: "+54 9 11 1234-5678" }));
    expect(c.telefone).toBe("+5491112345678");
  });

  it("documento que não é CPF (CNPJ, DNI) não vira chave", () => {
    const c = extrairChaves(pedidoNuvemshopSchema.parse({ ...base, contact_identification: "12.345.678/0001-90" }));
    expect(c.cpf).toBeNull();
  });

  it("e-mail sem @ é descartado", () => {
    expect(extrairChaves(pedidoNuvemshopSchema.parse({ ...base, contact_email: "sem-arroba" })).email).toBeNull();
  });
});

const chaves = (over: Partial<ChavesDoContato> = {}): ChavesDoContato => ({
  telefone: "+5511999990000", email: "ana@ex.com", cpf: "12345678909", nome: "Ana", ...over,
});

describe("decidirContato", () => {
  it("nenhuma chave → sem_chave", () => {
    expect(decidirContato(chaves({ telefone: null, email: null, cpf: null }), [])).toEqual({ acao: "sem_chave" });
  });

  it("telefone vence e-mail divergente", () => {
    const d = decidirContato(chaves(), [
      { id: "por-email", name: "X", email: "ana@ex.com", cpf_hash: null, via: "email" },
      { id: "por-telefone", name: "Ana", email: "outra@ex.com", cpf_hash: "h", via: "telefone" },
    ]);
    expect(d).toEqual({ acao: "usar", contatoId: "por-telefone", completar: {} });
  });

  it("completa só campos vazios", () => {
    const d = decidirContato(chaves(), [{ id: "c1", name: null, email: null, cpf_hash: null, via: "email" }]);
    expect(d).toEqual({ acao: "usar", contatoId: "c1", completar: { name: "Ana", email: "ana@ex.com", cpf: "12345678909" } });
  });

  it("só CPF casa", () => {
    const d = decidirContato(chaves({ telefone: null, email: null }), [
      { id: "c2", name: "Ana", email: "x@y.com", cpf_hash: "h", via: "cpf" },
    ]);
    expect(d).toMatchObject({ acao: "usar", contatoId: "c2" });
  });

  it("sem candidato e com chave → criar, nome cai para telefone", () => {
    expect(decidirContato(chaves({ nome: null, email: null, cpf: null }), [])).toEqual({
      acao: "criar",
      dados: { name: "+5511999990000", phone_number: "+5511999990000", email: null, cpf: null },
    });
  });
});
