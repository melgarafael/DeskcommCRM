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

import { crmDescribeExternalData, crmQueryExternalData, motivoDoVazioExterno } from "./dados-externos";

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
  maxRows: 200,
  maxFilters: 20,
  maxResponseBytes: 30_000,
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
      { connection_id: "conn-1", schema: "public", tabela: "nao_existe", limite: 20 },
      ctxFake(),
    )) as Record<string, unknown>;
    expect(r.erro).toBe("tabela_nao_encontrada");
    expect(lerTabela).not.toHaveBeenCalled();
  });

  it("pedido inválido (coluna/operador) vira erro de ensino, não exceção", async () => {
    vi.mocked(lerTabela).mockRejectedValue(new LeituraInvalidaError("coluna_inexistente:senha"));
    const r = (await crmQueryExternalData.handler(
      {
        connection_id: "conn-1",
        schema: "public",
        tabela: "assinaturas",
        filtros: [{ coluna: "senha", operador: "eq", valor: "x" }],
        limite: 20,
      },
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
      { connection_id: "conn-1", schema: "public", tabela: "assinaturas", limite: 20 },
      ctxFake(),
    )) as Record<string, unknown>;
    expect(r.linhas).toHaveLength(1);
    expect(r.truncado).toBe(true);
    expect(r.aviso).toBeTruthy();
  });

  it("descobre o schema quando ele não é informado e há só uma candidata", async () => {
    vi.mocked(lerTabela).mockResolvedValue({ colunas: ["id"], linhas: [], limite: 20, offset: 0 });
    const r = (await crmQueryExternalData.handler(
      { connection_id: "conn-1", tabela: "assinaturas", limite: 20 },
      ctxFake(),
    )) as Record<string, unknown>;
    expect(r.schema).toBe("public");
    expect(r.aviso).toBeTruthy();
  });

  it("usa o teto de linhas DA CONEXÃO, não o pedido pelo modelo", async () => {
    vi.mocked(abrirAcesso).mockResolvedValue({
      ok: true,
      conexao: { ...CONEXAO, maxRows: 150 },
      pool: {} as never,
    });
    vi.mocked(lerTabela).mockResolvedValue({ colunas: ["id"], linhas: [], limite: 150, offset: 0 });

    await crmQueryExternalData.handler(
      { connection_id: "conn-1", schema: "public", tabela: "assinaturas", limite: 5000 },
      ctxFake(),
    );

    const chamada = vi.mocked(lerTabela).mock.calls[0];
    expect((chamada?.[1] as { limite: number } | undefined)?.limite).toBe(150);
    expect(chamada?.[3]).toEqual({ limiteMax: 150 });
  });

  it("recusa quando os filtros passam do teto DA CONEXÃO", async () => {
    vi.mocked(abrirAcesso).mockResolvedValue({
      ok: true,
      conexao: { ...CONEXAO, maxFilters: 2 },
      pool: {} as never,
    });
    const r = (await crmQueryExternalData.handler(
      {
        connection_id: "conn-1",
        schema: "public",
        tabela: "assinaturas",
        filtros: [
          { coluna: "id", operador: "eq", valor: 1 },
          { coluna: "status", operador: "eq", valor: "ok" },
          { coluna: "id", operador: "ne", valor: 2 },
        ],
        limite: 20,
      },
      ctxFake(),
    )) as Record<string, unknown>;
    expect(r.erro).toBe("limite_de_filtros");
    expect(lerTabela).not.toHaveBeenCalled();
  });

  // Achado ao vivo (2026-09-19): o modelo mandava `{ coluna:"nome", operador:"contem" }`
  // SEM `valor` para buscar "CB 250". A versão anterior descartava o filtro em
  // silêncio e devolvia o catálogo inteiro — o turno seguia `success: true` e o
  // agente escolhia a moto no olho, sem a busca que o cliente pediu.
  it("filtro de comparação SEM valor vira erro de ensino, nunca catálogo inteiro", async () => {
    const r = (await crmQueryExternalData.handler(
      {
        connection_id: "conn-1",
        schema: "public",
        tabela: "assinaturas",
        filtros: [{ coluna: "status", operador: "contem" }],
        limite: 20,
      },
      ctxFake(),
    )) as Record<string, unknown>;
    expect(r.erro).toBe("filtro_sem_valor");
    expect(String(r.mensagem)).toContain("valor");
    // não toca o banco: sem valor, não há o que buscar
    expect(lerTabela).not.toHaveBeenCalled();
  });

  it("`nulo`/`nao_nulo` continuam válidos sem valor (ausência por definição)", async () => {
    vi.mocked(lerTabela).mockResolvedValue({ colunas: ["id"], linhas: [], limite: 20, offset: 0 });
    const r = (await crmQueryExternalData.handler(
      {
        connection_id: "conn-1",
        schema: "public",
        tabela: "assinaturas",
        filtros: [{ coluna: "status", operador: "nao_nulo" }],
        limite: 20,
      },
      ctxFake(),
    )) as Record<string, unknown>;
    expect(r.erro).toBeUndefined();
    expect(lerTabela).toHaveBeenCalled();
  });

  // A versão do #1130 reexecutava SEM filtro quando nada casava e entregava até
  // 100 linhas ao modelo. Numa tabela de clientes, o CPF que não casa mostraria
  // os registros de outras pessoas. Aqui o vazio fica vazio.
  it("filtro que não casa nada devolve vazio, nunca a tabela sem o filtro", async () => {
    // A 2ª leitura teria linha: é o registro de outra pessoa que não pode vazar.
    vi.mocked(lerTabela)
      .mockResolvedValueOnce({ colunas: ["id"], linhas: [], limite: 20, offset: 0 })
      .mockResolvedValue({ colunas: ["id"], linhas: [{ id: "de-outra-pessoa" }], limite: 20, offset: 0 });
    const r = (await crmQueryExternalData.handler(
      {
        connection_id: "conn-1",
        schema: "public",
        tabela: "assinaturas",
        filtros: [{ coluna: "status", operador: "eq", valor: "nao-existe" }],
        limite: 20,
      },
      ctxFake(),
    )) as Record<string, unknown>;
    expect(r.linhas).toEqual([]);
    expect(r.filtro_sem_resultado).toBeTruthy();
    expect(lerTabela).toHaveBeenCalledTimes(1);
    expect(vi.mocked(lerTabela).mock.calls[0]![1].filtros).toHaveLength(1);
  });
});

describe("motivoDoVazioExterno — o audit não conta erro como sucesso (#484)", () => {
  it("erro devolvido ao modelo e consulta sem linha viram motivo; resposta com linha, não", () => {
    expect(motivoDoVazioExterno({ erro: "acesso_negado", mensagem: "x" })).toBe("acesso_negado");
    expect(motivoDoVazioExterno({ linhas: [], linhas_devolvidas: 0 })).toBe("nenhuma_linha");
    expect(motivoDoVazioExterno({ linhas: [{ id: 1 }], linhas_devolvidas: 1 })).toBeNull();
    expect(motivoDoVazioExterno({ tabelas: [] })).toBeNull();
    expect(crmQueryExternalData.motivoDoVazio).toBe(motivoDoVazioExterno);
    expect(crmDescribeExternalData.motivoDoVazio).toBe(motivoDoVazioExterno);
  });
});
