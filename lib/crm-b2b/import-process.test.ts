import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { MENSAGEM_DE_CNPJ_INVALIDO } from "@/lib/crm-b2b/normalize";

import { processCompaniesPeopleImport } from "./import-process";

vi.mock("@/lib/crm-b2b/enrich", () => ({ enrichCompanyFromBrasilApi: vi.fn() }));

type Escrita = { tabela: string; operacao: string; dados: Record<string, unknown> };
type RespostaDeEscrita = { data: null; error: { code: string; message: string } | null };
type Consulta = {
  insert(dados: Record<string, unknown>): Consulta;
  update(dados: Record<string, unknown>): Consulta;
  upsert(dados: Record<string, unknown>): Consulta;
  select(): Consulta;
  eq(): Consulta;
  maybeSingle(): Promise<{ data: null; error: null }>;
  single(): Promise<{ data: { id: string }; error: null }>;
  then(resolve: (valor: RespostaDeEscrita) => unknown): Promise<unknown>;
};

/** Executa o processador público inteiro; só a persistência é dublada, sem rede. */
function banco(falhasDeVinculo: number) {
  const escritas: Escrita[] = [];
  let sequencia = 0;
  const cliente = {
    from(tabela: string) {
      let error: RespostaDeEscrita["error"] = null;
      const consulta: Consulta = {
        insert(dados: Record<string, unknown>) {
          escritas.push({ tabela, operacao: "insert", dados });
          return consulta;
        },
        update(dados: Record<string, unknown>) {
          escritas.push({ tabela, operacao: "update", dados });
          return consulta;
        },
        upsert(dados: Record<string, unknown>) {
          escritas.push({ tabela, operacao: "upsert", dados });
          if (tabela === "company_people" && falhasDeVinculo > 0) {
            falhasDeVinculo -= 1;
            error = { code: "57014", message: "canceling statement due to statement timeout" };
          }
          return consulta;
        },
        select() {
          return consulta;
        },
        eq() {
          return consulta;
        },
        maybeSingle: async () => ({ data: null, error: null }),
        single: async () => ({ data: { id: `${tabela}-${++sequencia}` }, error: null }),
        then(resolve: (valor: RespostaDeEscrita) => unknown) {
          return Promise.resolve({ data: null, error }).then(resolve);
        },
      };
      return consulta;
    },
  } as unknown as SupabaseClient;
  return { cliente, escritas };
}

async function importar(rows: string[][], falhasDeVinculo = 0) {
  const db = banco(falhasDeVinculo);
  const resultado = await processCompaniesPeopleImport(db.cliente, {
    organizationId: "11111111-1111-4111-8111-111111111111",
    userId: "22222222-2222-4222-8222-222222222222",
    batchId: "33333333-3333-4333-8333-333333333333",
    sheet: { headers: ["Empresa", "CNPJ", "Pessoa", "Telefone"], rows },
    mapping: { company_name: "Empresa", cnpj: "CNPJ", person_name: "Pessoa", phone: "Telefone" },
    enrichCompanies: false,
  });
  return { ...db, resultado };
}

describe("importação distingue CNPJ inválido de ausente (#3497)", () => {
  it("documentos inválidos distintos com o mesmo nome falham sem criar entidades ou vínculos", async () => {
    const { resultado, escritas } = await importar([
      ["Mesma Empresa", "11.222.333/0001-00", "Pessoa A", "85999991111"],
      ["Mesma Empresa", "11222333000182", "Pessoa B", "85988881111"],
    ]);
    expect(resultado).toEqual({
      successful_rows: 0,
      failed_rows: 2,
      conflict_rows: 0,
      processed_rows: 2,
    });
    expect(escritas.filter((e) => !["import_batches", "import_rows"].includes(e.tabela))).toEqual(
      [],
    );
    const linhas = escritas.filter((e) => e.tabela === "import_rows" && e.operacao === "update");
    expect(linhas).toHaveLength(2);
    for (const { dados } of linhas) {
      expect(dados).toMatchObject({
        status: "failed",
        error: MENSAGEM_DE_CNPJ_INVALIDO,
        company_id: null,
        person_id: null,
        contact_id: null,
      });
    }
  });

  it("CNPJ em branco conserva o agrupamento por nome dentro do lote", async () => {
    const { resultado, escritas } = await importar([
      ["Mesma Empresa", "", "", ""],
      ["Mesma Empresa", "  ", "", ""],
    ]);
    expect(resultado.successful_rows).toBe(2);
    const empresas = escritas.filter((e) => e.tabela === "companies");
    expect(empresas).toHaveLength(1);
    expect(empresas[0]!.dados).not.toHaveProperty("cnpj");
  });

  it("CNPJ válido com e sem máscara conserva dedupe e documento da empresa", async () => {
    const { resultado, escritas } = await importar([
      ["Empresa", "11.222.333/0001-81", "", ""],
      ["Empresa", "11222333000181", "", ""],
    ]);
    expect(resultado.successful_rows).toBe(2);
    const empresas = escritas.filter((e) => e.tabela === "companies");
    expect(empresas).toHaveLength(1);
    expect(empresas[0]!.dados).toMatchObject({
      organization_id: "11111111-1111-4111-8111-111111111111",
      cnpj: "11222333000181",
      normalized_cnpj: "11222333000181",
    });
  });

  /**
   * A planilha é a porta por onde o documento errado entra em lote: uma coluna
   * inteira copiada de um sistema antigo. Ela confere pela MESMA régua do
   * cadastro (`normalizeCnpj` → `isValidCnpj`), então o alfanumérico da Receita
   * passa e o DV trocado reprova a linha com o motivo escrito (#3495).
   */
  it("CNPJ alfanumérico da Receita entra normalizado em maiúsculas", async () => {
    const { resultado, escritas } = await importar([
      ["Empresa Alfa", "12.abc.345/01de-35", "", ""],
    ]);
    expect(resultado.successful_rows).toBe(1);
    const empresas = escritas.filter((e) => e.tabela === "companies");
    expect(empresas).toHaveLength(1);
    expect(empresas[0]!.dados).toMatchObject({
      cnpj: "12ABC34501DE35",
      normalized_cnpj: "12ABC34501DE35",
    });
  });

  it("CNPJ alfanumérico com o DV errado falha a linha sem criar empresa", async () => {
    const { resultado, escritas } = await importar([["Empresa Alfa", "12ABC34501DE36", "", ""]]);
    expect(resultado.failed_rows).toBe(1);
    expect(escritas.filter((e) => e.tabela === "companies")).toEqual([]);
    const linhas = escritas.filter((e) => e.tabela === "import_rows" && e.operacao === "update");
    expect(linhas).toHaveLength(1);
    expect(linhas[0]!.dados).toMatchObject({
      status: "failed",
      error:
        "CNPJ inválido: confira as 12 posições (dígitos ou letras) e os 2 dígitos verificadores.",
    });
  });
});

describe("vínculo entre empresa e pessoa na importação", () => {
  const linha = ["Empresa", "11222333000181", "Pessoa A", ""];

  it("registra a falha de vínculo no histórico da linha e no total do lote", async () => {
    const { resultado, escritas } = await importar([linha], 1);

    expect(resultado).toEqual({
      successful_rows: 0,
      failed_rows: 1,
      conflict_rows: 0,
      processed_rows: 1,
    });
    expect(
      escritas.find((e) => e.tabela === "import_rows" && e.operacao === "update")?.dados,
    ).toMatchObject({
      status: "failed",
      error: "Falha ao vincular a pessoa à empresa.",
      company_id: "companies-2",
      person_id: "people-3",
    });
    expect(escritas.at(-1)?.dados).toMatchObject({
      status: "completed",
      successful_rows: 0,
      failed_rows: 1,
    });
  });

  it("tenta o vínculo na próxima linha com os mesmos IDs e reutiliza o vínculo confirmado", async () => {
    const { resultado, escritas } = await importar([linha, linha, linha], 1);

    expect(
      escritas.filter((e) => e.tabela === "companies" && e.operacao === "insert"),
    ).toHaveLength(1);
    expect(escritas.filter((e) => e.tabela === "people" && e.operacao === "insert")).toHaveLength(
      1,
    );
    const vinculos = escritas.filter((e) => e.tabela === "company_people");
    expect(vinculos).toHaveLength(2);
    expect(vinculos[1]).toEqual(vinculos[0]);
    expect(
      escritas
        .filter((e) => e.tabela === "import_rows" && e.operacao === "update")
        .map((e) => e.dados.status),
    ).toEqual(["failed", "success", "success"]);
    expect(resultado).toMatchObject({ successful_rows: 2, failed_rows: 1, processed_rows: 3 });
  });
});
