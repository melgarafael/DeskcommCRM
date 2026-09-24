import { describe, expect, it, vi } from "vitest";

import { createBrasilApiClient, mapBrasilApiToCompanyFields } from "@/lib/brasil-api/client";
import { formatCnpj, normalizeCnpj, normalizePersonName } from "@/lib/crm-b2b/normalize";
import { applyMapping, suggestColumnMapping } from "@/lib/crm-b2b/spreadsheet";

describe("normalizeCnpj", () => {
  it("aceita máscara e devolve 14 dígitos", () => {
    expect(normalizeCnpj("11.222.333/0001-81")).toBe("11222333000181");
  });
  it("rejeita tamanho errado e sequência trivial", () => {
    expect(normalizeCnpj("123")).toBeNull();
    expect(normalizeCnpj("00000000000000")).toBeNull();
  });
  it("formatCnpj round-trip visual", () => {
    expect(formatCnpj("11222333000181")).toBe("11.222.333/0001-81");
  });
});

describe("normalizePersonName", () => {
  it("remove acento e colapsa espaços", () => {
    expect(normalizePersonName("  José   da Silva ")).toBe("jose da silva");
  });
});

describe("suggestColumnMapping", () => {
  it("reconhece cabeçalhos pt-BR", () => {
    const m = suggestColumnMapping(["Empresa", "CNPJ", "Pessoa", "Telefone", "Cargo"]);
    expect(m.company_name).toBe("Empresa");
    expect(m.cnpj).toBe("CNPJ");
    expect(m.person_name).toBe("Pessoa");
    expect(m.phone).toBe("Telefone");
    expect(m.job_title).toBe("Cargo");
  });
});

describe("applyMapping", () => {
  it("extrai campos pela coluna mapeada", () => {
    const headers = ["Razão", "CNPJ", "Nome", "Fone"];
    const mapping = {
      legal_name: "Razão",
      cnpj: "CNPJ",
      person_name: "Nome",
      phone: "Fone",
    };
    const row = applyMapping(headers, ["Globo", "11222333000181", "José", "85999991111"], mapping);
    expect(row.legal_name).toBe("Globo");
    expect(row.phone).toBe("85999991111");
  });
});

describe("BrasilAPI client", () => {
  it("invalid_cnpj sem chamar rede", async () => {
    const client = createBrasilApiClient({ fetchFn: vi.fn() as unknown as typeof fetch });
    const r = await client.lookupCnpj("123");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_cnpj");
  });

  it("mapeia 404", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    const client = createBrasilApiClient({ fetchFn: fetchFn as unknown as typeof fetch });
    const r = await client.lookupCnpj("11222333000181");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("not_found");
  });

  it("mapBrasilApiToCompanyFields preenche razão social", () => {
    const fields = mapBrasilApiToCompanyFields({
      razao_social: "ACME LTDA",
      nome_fantasia: "Acme",
      municipio: "Fortaleza",
      uf: "CE",
    });
    expect(fields.legal_name).toBe("ACME LTDA");
    expect(fields.city).toBe("Fortaleza");
  });
});
