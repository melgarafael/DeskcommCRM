import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/external-db/acesso", () => ({ abrirAcesso: vi.fn() }));
vi.mock("@/lib/external-db/introspeccao", () => ({
  listarTabelas: vi.fn(),
  colunasDaTabela: vi.fn(),
}));
vi.mock("@/lib/external-db/leitura", async () => {
  const real = (await vi.importActual("@/lib/external-db/leitura")) as Record<string, unknown>;
  return { ...real, lerTabela: vi.fn() };
});

import { abrirAcesso } from "@/lib/external-db/acesso";
import { colunasDaTabela, listarTabelas } from "@/lib/external-db/introspeccao";
import { LeituraInvalidaError, lerTabela } from "@/lib/external-db/leitura";
import type { ConexaoExterna, TabelaExterna } from "@/lib/external-db/types";
import type { McpContext } from "@/lib/mcp/types";

import { crmDescribeExternalData, crmQueryExternalData } from "./dados-externos";

const CONEXAO: ConexaoExterna = {
  id: "conn-1",
  organizationId: "org-1",
  label: "Outro CRM",
  host: "db.exemplo.com",
  port: 5432,
  database: "outro_crm",
  username: "leitor",
  password: "segredo",
  sslMode: "require",
  versao: "2026-09-11T00:00:00.000Z",
};

const TABELA: TabelaExterna = {
  schema: "public",
  nome: "assinaturas",
  tipo: "tabela",
  colunas: [
    { nome: "id", tipo: "uuid", nulavel: false, posicao: 1 },
    { nome: "status", tipo: "text", nulavel: true, posicao: 2 },
  ],
  chavePrimaria: ["id"],
  estimativaLinhas: 4200,
};

function ctxFake(conexoes: Array<{ id: string; label: string }> = [{ id: "conn-1", label: "Outro CRM" }]) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    order: async () => ({ data: conexoes, error: null }),
  };
  return {
    organizationId: "org-1",
    role: "agent",
    actor: { type: "ai_agent", id: "agent-1" },
    apiTokenId: "tok-1",
    requestId: "req-1",
    supabase: { from: () => chain },
  } as unknown as McpContext;
}

beforeEach(() => {
  vi.mocked(abrirAcesso).mockReset();
  vi.mocked(listarTabelas).mockReset();
  vi.mocked(colunasDaTabela).mockReset();
  vi.mocked(lerTabela).mockReset();
  vi.mocked(abrirAcesso).mockResolvedValue({ ok: true, conexao: CONEXAO, pool: {} as never });
  vi.mocked(listarTabelas).mockResolvedValue([TABELA]);
  vi.mocked(colunasDaTabela).mockResolvedValue(new Set(["id", "status"]));
});

describe("crm_describe_external_data", () => {
  it("é leitura e não exige papel acima do agente", () => {
    expect(crmDescribeExternalData.category).toBe("read");
    expect(crmDescribeExternalData.requiresScope).toBe("mcp:read");
    expect(crmDescribeExternalData.requiresRole).toBe("agent");
  });

  it("resolve a única conexão ativa e descreve as tabelas", async () => {
    const r = (await crmDescribeExternalData.handler({}, ctxFake())) as Record<string, unknown>;
    expect(r.tabelas).toHaveLength(1);
    expect((r.tabelas as TabelaExterna[])[0]?.nome).toBe("assinaturas");
    expect((r.tabelas as Array<{ chave: string[] }>)[0]?.chave).toEqual(["id"]);
  });

  it("filtra por nome de tabela e devolve vazio quando não acha", async () => {
    const tabelas = [
      TABELA,
      { ...TABELA, nome: "pedidos", chavePrimaria: ["id"] },
    ];
    vi.mocked(listarTabelas).mockResolvedValue(tabelas);

    const ok = (await crmDescribeExternalData.handler({ tabela: "ped" }, ctxFake())) as Record<
      string,
      unknown
    >;
    expect((ok.tabelas as TabelaExterna[]).map((t) => t.nome)).toEqual(["pedidos"]);

    const nada = (await crmDescribeExternalData.handler({ tabela: "inexistente" }, ctxFake())) as Record<
      string,
      unknown
    >;
    expect(nada.erro).toBe("tabela_nao_encontrada");
  });

  it("com mais de uma conexão e sem id, pede para escolher", async () => {
    const ctx = ctxFake([
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ]);
    const r = (await crmDescribeExternalData.handler({}, ctx)) as Record<string, unknown>;
    expect(r.erro).toBe("conexao_ambigua");
    expect(r.conexoes).toHaveLength(2);
  });

  it("sem conexão ativa, explica em vez de lançar", async () => {
    const r = (await crmDescribeExternalData.handler({}, ctxFake([]))) as Record<string, unknown>;
    expect(r.erro).toBe("sem_conexao");
  });
});

describe("crm_query_external_data", () => {
  it("é leitura, usa scope de leitura e redige os valores de filtro no audit", () => {
    expect(crmQueryExternalData.category).toBe("read");
    expect(crmQueryExternalData.requiresScope).toBe("mcp:read");
    const redigido = crmQueryExternalData.redigirParaAuditoria?.({
      tabela: "assinaturas",
      filtros: [{ coluna: "email", operador: "eq", valor: "cliente@exemplo.com" }],
    }) as { filtros: Array<Record<string, unknown>> };
    expect(redigido.filtros[0]).toEqual({ coluna: "email", operador: "eq" });
    expect(JSON.stringify(redigido)).not.toContain("cliente@exemplo.com");
  });

  it("recusa tabela inexistente sem tocar no banco", async () => {
    vi.mocked(colunasDaTabela).mockResolvedValue(null);
    const r = (await crmQueryExternalData.handler(
      { connection_id: "conn-1", schema: "public", tabela: "nao_existe" },
      ctxFake(),
    )) as Record<string, unknown>;
    expect(r.erro).toBe("tabela_nao_encontrada");
    expect(lerTabela).not.toHaveBeenCalled();
  });

  it("pedido inválido (coluna/operador) vira erro de ensino, não exceção", async () => {
    vi.mocked(lerTabela).mockRejectedValue(new LeituraInvalidaError("coluna_inexistente:senha"));
    const r = (await crmQueryExternalData.handler(
      { connection_id: "conn-1", schema: "public", tabela: "assinaturas", filtros: [{ coluna: "senha", operador: "eq", valor: "x" }] },
      ctxFake(),
    )) as Record<string, unknown>;
    expect(r.erro).toBe("pedido_invalido");
  });

  it("devolve as linhas e marca truncagem por orçamento de bytes", async () => {
    const grandona = { id: "1", status: "x".repeat(20_000) };
    vi.mocked(lerTabela).mockResolvedValue({
      colunas: ["id", "status"],
      linhas: [grandona, grandona],
      limite: 20,
      offset: 0,
    });
    const r = (await crmQueryExternalData.handler(
      { connection_id: "conn-1", schema: "public", tabela: "assinaturas" },
      ctxFake(),
    )) as Record<string, unknown>;
    expect(r.linhas).toHaveLength(1);
    expect(r.truncado).toBe(true);
    expect(r.aviso).toBeTruthy();
  });

  it("descobre o schema quando ele não é informado e há só uma candidata", async () => {
    vi.mocked(lerTabela).mockResolvedValue({ colunas: ["id"], linhas: [], limite: 20, offset: 0 });
    const r = (await crmQueryExternalData.handler(
      { connection_id: "conn-1", tabela: "assinaturas" },
      ctxFake(),
    )) as Record<string, unknown>;
    expect(r.schema).toBe("public");
    expect(r.aviso).toBeTruthy();
  });
});
