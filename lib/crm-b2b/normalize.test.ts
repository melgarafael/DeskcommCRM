import { describe, expect, it, vi } from "vitest";

import { createBrasilApiClient, mapBrasilApiToCompanyFields } from "@/lib/brasil-api/client";
import { formatCnpj, normalizeCnpj, normalizePersonName } from "@/lib/crm-b2b/normalize";
import { applyMapping, suggestColumnMapping } from "@/lib/crm-b2b/spreadsheet";

/**
 * A tabela da régua de CNPJ, caso a caso (#3495). O formato alfanumérico é o da
 * Receita Federal: 12 posições de dígito OU letra e 2 dígitos verificadores, com
 * a letra em MAIÚSCULA. `12.ABC.345/01DE-35` é o exemplo canônico da Nota
 * Técnica — sem dono real, DV 35 conferido pelo mod-11 de lá.
 *
 * A RÉGUA É UMA SÓ: quem confere o dígito aqui é `isValidCnpj`, a mesma função
 * da cobrança (`lib/cobranca/documento.ts`), e o teste dos dois caminhos é o
 * mesmo, abaixo em `lib/cobranca/documento.test.ts`.
 */
const VALIDOS: Array<[string, unknown, string]> = [
  ["numérico com máscara", "11.222.333/0001-81", "11222333000181"],
  ["numérico sem máscara", "11222333000181", "11222333000181"],
  ["numérico como número", 11222333000181, "11222333000181"],
  ["alfanumérico da Receita com máscara", "12.ABC.345/01DE-35", "12ABC34501DE35"],
  ["alfanumérico sem máscara", "12ABC34501DE35", "12ABC34501DE35"],
  ["alfanumérico em minúsculas", "12.abc.345/01de-35", "12ABC34501DE35"],
];

/**
 * Os que a rota de empresa tem de recusar com mensagem, não gravar. O caso que
 * dava empresa fantasma é o DV errado com 14 dígitos e máscara certa; o
 * alfanumérico com DV trocado só se distingue do válido pelo mod-11.
 */
const INVALIDOS: Array<[string, unknown]> = [
  ["numérico com o DV errado e máscara certa", "11.222.333/0001-00"],
  ["numérico com o DV errado, sem máscara", "11222333000100"],
  ["numérico com o segundo dígito errado", "11.222.333/0001-80"],
  ["alfanumérico com o DV errado", "12ABC34501DE36"],
  ["alfanumérico com letra no lugar do DV", "12ABC34501DEX5"],
  ["sequência repetida", "00000000000000"],
  ["tamanho curto", "123"],
  ["13 posições em vez de 14", "12ABC34501DE3"],
  ["15 posições em vez de 14", "12ABC34501DE355"],
];

describe("normalizeCnpj", () => {
  it.each(VALIDOS)("aceita o CNPJ %s", (_caso, entrada, esperado) => {
    expect(normalizeCnpj(entrada)).toBe(esperado);
  });

  it.each(INVALIDOS)("recusa o CNPJ %s", (_caso, entrada) => {
    expect(normalizeCnpj(entrada)).toBeNull();
  });

  it("devolve o alfanumérico em MAIÚSCULA, que é a forma que a Receita publica", () => {
    expect(normalizeCnpj("12abc34501de35")).toBe("12ABC34501DE35");
  });

  it.each([
    ["11222333000181", "11.222.333/0001-81"],
    ["12ABC34501DE35", "12.ABC.345/01DE-35"],
    ["12abc34501de35", "12.ABC.345/01DE-35"],
  ])("formatCnpj devolve a máscara visual de %s", (entrada, esperado) => {
    expect(formatCnpj(entrada)).toBe(esperado);
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
