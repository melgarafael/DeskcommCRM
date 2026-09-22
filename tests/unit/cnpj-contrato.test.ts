import { describe, expect, it, vi } from "vitest";

import {
  buscarCnpj,
  formatarCnpj,
  isValidCnpj,
  mapearParaContato,
  normalizarCnpj,
} from "@/lib/brasil/cnpj";

/**
 * O CNPJ — cerca do cadastro PJ com autocomplete.
 * Rede sempre mockada aqui; o vivo vai no E2E.
 */
describe("isValidCnpj", () => {
  it("aceita válido com e sem máscara", () => {
    expect(isValidCnpj("11.222.333/0001-81")).toBe(true);
    expect(isValidCnpj("11222333000181")).toBe(true);
  });

  it("recusa repetido, curto e dígito errado", () => {
    expect(isValidCnpj("00000000000000")).toBe(false);
    expect(isValidCnpj("123")).toBe(false);
    expect(isValidCnpj("11.222.333/0001-82")).toBe(false);
  });
});

describe("normalizarCnpj / formatarCnpj", () => {
  it("normaliza e formata", () => {
    expect(normalizarCnpj("12.345.678/0001-90")).toBe("12345678000190");
    expect(normalizarCnpj("abc")).toBeNull();
    expect(formatarCnpj("12345678000190")).toBe("12.345.678/0001-90");
  });
});

describe("buscarCnpj", () => {
  it("dígito inválido nem sai à rede", async () => {
    const fetch = vi.fn();
    const r = await buscarCnpj("123", fetch as unknown as typeof window.fetch);
    expect(r).toEqual({ ok: false, erro: "cnpj_invalido" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("404 vira nao_encontrado", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: false, status: 404, json: () => Promise.resolve({}) });
    const r = await buscarCnpj("11.222.333/0001-81", fetch as unknown as typeof window.fetch);
    expect(r).toEqual({ ok: false, erro: "nao_encontrado" });
  });

  it("mapeia resposta da BrasilAPI", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          cnpj: "11222333000181",
          razao_social: "Empresa Teste LTDA",
          nome_fantasia: "Teste",
          email: "contato@teste.com.br",
          ddd_telefone_1: "47999999999",
          logradouro: "Rua A",
          numero: "100",
          bairro: "Centro",
          municipio: "Canoinhas",
          uf: "SC",
          cep: "89460-000",
          descricao_situacao_cadastral: "ATIVA",
        }),
    });
    const r = await buscarCnpj("11.222.333/0001-81", fetch as unknown as typeof window.fetch);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.empresa.razao_social).toBe("Empresa Teste LTDA");
    const c = mapearParaContato(r.empresa);
    expect(c).toMatchObject({
      cnpj: "11222333000181",
      name: "Empresa Teste LTDA",
      display_name: "Teste",
      email: "contato@teste.com.br",
      phone_number: "+5547999999999",
    });
    expect((c.source_metadata.receita as { situacao: string }).situacao).toBe("ATIVA");
  });
});
