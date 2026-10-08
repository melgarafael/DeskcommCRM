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
import { LeituraInvalidaError, lerTabela, montarConsulta } from "@/lib/external-db/leitura";
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
  chaveDoCliente: null,
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

  it("módulo desligado na hora de abrir o acesso: mensagem própria, não o 'não foi possível' genérico", async () => {
    vi.mocked(abrirAcesso).mockResolvedValue({ ok: false, motivo: "modulo_desligado" });
    const r = (await crmDescribeExternalData.handler({}, ctxFake())) as Record<string, unknown>;
    expect(r.erro).toBe("acesso_negado");
    expect(String(r.mensagem)).toContain("módulo");
    expect(String(r.mensagem)).not.toBe("não foi possível abrir a conexão.");
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

  // Tabela criada por ORM com maiúscula ("Pedido"): o modelo escreve `pedido`.
  // A busca no catálogo compara em minúscula e ACHA; a conferência de colunas e a
  // consulta usavam o texto do MODELO e comparavam por igualdade exata — o agente
  // recebia "essa tabela não existe" para uma tabela que existe.
  describe("nome da tabela com maiúscula", () => {
    const PEDIDO: TabelaExterna = { ...TABELA, nome: "Pedido" };

    beforeEach(() => {
      vi.mocked(listarTabelas).mockResolvedValue([PEDIDO]);
      // Só o nome REAL existe para o catálogo: igualdade exata, como o SQL de verdade.
      vi.mocked(colunasDaTabela).mockImplementation(async (_pool, _schema, tabela) =>
        tabela === "Pedido" ? new Set(["id", "status"]) : null,
      );
      vi.mocked(lerTabela).mockResolvedValue({ colunas: ["id"], linhas: [{ id: "1" }], limite: 20, offset: 0 });
    });

    it("sem schema: acha `Pedido` pedido como `pedido` e consulta pelo nome real", async () => {
      const r = (await crmQueryExternalData.handler(
        { connection_id: "conn-1", tabela: "pedido", limite: 20 },
        ctxFake(),
      )) as Record<string, unknown>;
      expect(r.erro).toBeUndefined();
      expect(r.tabela).toBe("Pedido");
      expect(vi.mocked(lerTabela).mock.calls[0]![1].tabela).toBe("Pedido");
    });

    it("com schema informado e tabela em minúscula: cai no catálogo e usa o nome real", async () => {
      const r = (await crmQueryExternalData.handler(
        { connection_id: "conn-1", schema: "public", tabela: "pedido", limite: 20 },
        ctxFake(),
      )) as Record<string, unknown>;
      expect(r.erro).toBeUndefined();
      expect(r.tabela).toBe("Pedido");
      expect(vi.mocked(lerTabela).mock.calls[0]![1].tabela).toBe("Pedido");
    });

    it("duas candidatas em schemas diferentes: continua preferindo `public` e devolve o nome da escolhida", async () => {
      vi.mocked(listarTabelas).mockResolvedValue([
        { ...TABELA, schema: "outro", nome: "pedido" },
        { ...TABELA, schema: "public", nome: "Pedido" },
      ]);
      vi.mocked(colunasDaTabela).mockImplementation(async (_pool, schema, tabela) =>
        schema === "public" && tabela === "Pedido" ? new Set(["id"]) : schema === "outro" && tabela === "pedido" ? new Set(["id"]) : null,
      );
      const r = (await crmQueryExternalData.handler(
        { connection_id: "conn-1", tabela: "PEDIDO", limite: 20 },
        ctxFake(),
      )) as Record<string, unknown>;
      expect(r.schema).toBe("public");
      expect(r.tabela).toBe("Pedido");
    });

    it("`Pedido` e `pedido` no mesmo schema: quem pede `pedido` lê `pedido`, não a vizinha de outra caixa", async () => {
      vi.mocked(listarTabelas).mockResolvedValue([
        { ...TABELA, schema: "public", nome: "Pedido" },
        { ...TABELA, schema: "public", nome: "pedido" },
      ]);
      vi.mocked(colunasDaTabela).mockImplementation(async (_p, schema, tabela) =>
        schema === "public" && (tabela === "Pedido" || tabela === "pedido") ? new Set(["id"]) : null,
      );
      await crmQueryExternalData.handler({ connection_id: "conn-1", tabela: "pedido", limite: 20 }, ctxFake());
      expect(vi.mocked(lerTabela).mock.calls[0]![1].tabela).toBe("pedido");
    });

    it("tabela que não existe em nenhuma caixa continua `tabela_nao_encontrada`", async () => {
      const r = (await crmQueryExternalData.handler(
        { connection_id: "conn-1", tabela: "fatura", limite: 20 },
        ctxFake(),
      )) as Record<string, unknown>;
      expect(r.erro).toBe("tabela_nao_encontrada");
      expect(lerTabela).not.toHaveBeenCalled();
    });
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

describe("crm_query_external_data durante a conversa: só as linhas do cliente", () => {
  // `contatoDoTurno` é contexto de confiança do runtime; o valor do filtro sai
  // do cadastro do contato, nunca do modelo.
  const PEDIDO = { connection_id: "conn-1", schema: "public", tabela: "assinaturas", limite: 20 };
  const COM_CHAVE: ConexaoExterna = { ...CONEXAO, chaveDoCliente: { coluna: "telefone", tipo: "phone" } };

  /** ctx de turno: registra os `.eq()` da leitura do contato para provar org + id. */
  function ctxDoTurno(contato: { phone_number: string | null; email: string | null } | null) {
    const eq: Array<[string, unknown]> = [];
    const chain = {
      select: () => chain,
      eq: (c: string, v: unknown) => {
        eq.push([c, v]);
        return chain;
      },
      order: async () => ({ data: [{ id: "conn-1", label: "Outro CRM" }], error: null }),
      maybeSingle: async () => ({ data: contato, error: null }),
    };
    const ctx = { ...ctxFake(), contatoDoTurno: "contato-1", supabase: { from: () => chain } } as unknown as McpContext;
    return { ctx, eq };
  }

  beforeEach(() => {
    vi.mocked(colunasDaTabela).mockResolvedValue(new Set(["id", "status", "telefone", "email"]));
    vi.mocked(lerTabela).mockResolvedValue({ colunas: ["id"], linhas: [], limite: 20, offset: 0 });
  });

  it("conexão sem a coluna configurada: a consulta segue como antes, sem filtro do cliente", async () => {
    const { ctx, eq } = ctxDoTurno({ phone_number: "+5511999998888", email: null });
    const r = (await crmQueryExternalData.handler(PEDIDO, ctx)) as Record<string, unknown>;
    expect(r.erro).toBeUndefined();
    expect(vi.mocked(lerTabela).mock.calls[0]![1].filtros).toEqual([]);
    // Sem coluna, o contato nem é lido.
    expect(eq).not.toContainEqual(["id", "contato-1"]);
  });

  it("com a coluna configurada, o filtro do cliente entra junto com o do modelo", async () => {
    vi.mocked(abrirAcesso).mockResolvedValue({ ok: true, conexao: COM_CHAVE, pool: {} as never });
    const { ctx, eq } = ctxDoTurno({ phone_number: "+5511999998888", email: null });
    // O modelo tenta o telefone de OUTRA pessoa: o filtro dele soma, não substitui.
    await crmQueryExternalData.handler(
      { ...PEDIDO, filtros: [{ coluna: "telefone", operador: "eq", valor: "5521988887777" }] },
      ctx,
    );
    expect(eq).toEqual(
      expect.arrayContaining([
        ["organization_id", "org-1"],
        ["id", "contato-1"],
      ]),
    );
    const pedido = vi.mocked(lerTabela).mock.calls[0]![1];
    expect(pedido.filtros).toEqual([
      { coluna: "telefone", operador: "eq", valor: "5521988887777" },
      { coluna: "telefone", operador: "in", valor: ["+5511999998888", "5511999998888", "11999998888"] },
    ]);
    // Parametrizado: o telefone do cliente vai nos values, nunca no texto do SQL.
    const sql = montarConsulta(pedido, new Set(["id", "status", "telefone"]));
    expect(sql.text).toContain('"telefone" in ($2, $3, $4)');
    expect(sql.text).not.toContain("5511999998888");
    expect(sql.text).toContain(" and ");
  });

  it("por e-mail, o valor é o do contato (e a forma minúscula)", async () => {
    vi.mocked(abrirAcesso).mockResolvedValue({
      ok: true,
      conexao: { ...CONEXAO, chaveDoCliente: { coluna: "email", tipo: "email" } },
      pool: {} as never,
    });
    const { ctx } = ctxDoTurno({ phone_number: null, email: "Ana@Loja.com" });
    await crmQueryExternalData.handler(PEDIDO, ctx);
    expect(vi.mocked(lerTabela).mock.calls[0]![1].filtros).toEqual([
      { coluna: "email", operador: "in", valor: ["Ana@Loja.com", "ana@loja.com"] },
    ]);
  });

  it("tabela sem a coluna do cliente: recusa em vez de ler sem o filtro", async () => {
    vi.mocked(abrirAcesso).mockResolvedValue({ ok: true, conexao: COM_CHAVE, pool: {} as never });
    vi.mocked(colunasDaTabela).mockResolvedValue(new Set(["id", "status"]));
    const { ctx } = ctxDoTurno({ phone_number: "+5511999998888", email: null });
    const r = (await crmQueryExternalData.handler(PEDIDO, ctx)) as Record<string, unknown>;
    expect(r.erro).toBe("tabela_sem_identificador_do_cliente");
    expect(lerTabela).not.toHaveBeenCalled();
  });

  it("contato sem o dado no cadastro: recusa", async () => {
    vi.mocked(abrirAcesso).mockResolvedValue({ ok: true, conexao: COM_CHAVE, pool: {} as never });
    const { ctx } = ctxDoTurno({ phone_number: null, email: "a@b.com" });
    const r = (await crmQueryExternalData.handler(PEDIDO, ctx)) as Record<string, unknown>;
    expect(r.erro).toBe("cliente_sem_identificador");
    expect(lerTabela).not.toHaveBeenCalled();
  });

  it("CONTROLE: fora da conversa, a consulta segue sem filtro do cliente, configurada ou não", async () => {
    vi.mocked(abrirAcesso).mockResolvedValue({ ok: true, conexao: COM_CHAVE, pool: {} as never });
    await crmQueryExternalData.handler(PEDIDO, ctxFake());
    expect(vi.mocked(lerTabela).mock.calls[0]![1].filtros).toEqual([]);
  });
});
