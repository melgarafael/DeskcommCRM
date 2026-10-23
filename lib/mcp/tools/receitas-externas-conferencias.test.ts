/**
 * `crm_consultar_receita` só executa quando TODAS as conferências passam:
 * organização do ctx, conexão ativa, módulo ligado, instância ativa, tabelas e
 * colunas liberadas. E o audit guarda o fato, não os valores da busca.
 *
 * Caminho real até o dialeto: `abrirAcesso`, `carregarConexao`,
 * `criarDialetoDeLeitura` e a receita woocommerce de verdade. Só o que sai da
 * máquina é dublê: o banco do CRM (filtra por `eq` de verdade), a cifra, o DNS e
 * as operações do motor MySQL.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { OperacoesDoMotor } from "@/lib/external-db/dialeto";
import type { ConexaoExterna } from "@/lib/external-db/types";
import type { McpContext } from "@/lib/mcp/types";

const m = vi.hoisted(() => ({
  modulo: vi.fn(),
  executar: vi.fn(),
  auditados: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: m.modulo }));
vi.mock("@/lib/external-db/guardas", () => ({
  validarHostDeBanco: async () => ({ ok: true, enderecos: ["203.0.113.10"] }),
}));
vi.mock("@/lib/crypto/aes_gcm", async (orig) => ({
  ...(await orig<typeof import("@/lib/crypto/aes_gcm")>()),
  decryptKey: () => "senha",
  byteaToBuffer: () => Buffer.alloc(0),
}));
vi.mock("@/lib/external-db/drivers", async () => {
  const { criarDialetoDeLeitura } = await import("@/lib/external-db/dialeto");
  const colunas = (nomes: string[]) => nomes.map((nome, i) => ({ nome, tipo: "text", nulavel: true, posicao: i }));
  const ops: OperacoesDoMotor = {
    listarTabelas: async () => [],
    descreverTabela: async (schema, tabela) => ({
      schema,
      nome: tabela,
      tipo: "tabela",
      chavePrimaria: [],
      estimativaLinhas: 0,
      colunas: colunas(
        tabela.endsWith("postmeta")
          ? ["meta_id", "post_id", "meta_key", "meta_value"]
          : ["ID", "post_title", "post_status", "post_type", "guid", "post_excerpt", "post_author"],
      ),
    }),
    lerTabela: async () => {
      throw new Error("não usado");
    },
    schemaDasReceitas: () => "loja",
    executarReceita: m.executar,
  };
  return {
    abrirDialeto: (c: ConexaoExterna) => criarDialetoDeLeitura(ops, { modo: c.sourceMode, fontes: c.fontes }),
  };
});
vi.mock("@/lib/audit", () => ({
  audit: async (e: Record<string, unknown>) => {
    m.auditados.push(e);
  },
}));

import { auditMcpToolCall } from "@/lib/mcp/audit";

import { crmConsultarReceita } from "./receitas-externas";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OUTRA_ORG = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CONEXAO = "11111111-1111-4111-8111-111111111111";
const INSTANCIA = "55555555-5555-4555-8555-555555555555";

function linha(over: Record<string, unknown> = {}, instancia: Record<string, unknown> = {}) {
  return {
    id: CONEXAO,
    organization_id: ORG,
    db_type: "mysql",
    label: "loja",
    host: "db.loja.example",
    port: 3306,
    database_name: "loja",
    username: "leitor",
    password_encrypted: "\\x00",
    password_iv: "\\x00",
    password_tag: "\\x00",
    ssl_mode: "require",
    enabled: true,
    max_rows: 200,
    max_filters: 20,
    max_response_bytes: 30000,
    customer_key_column: null,
    customer_key_kind: null,
    source_mode: "all",
    sources: [],
    updated_at: "2026-10-21T00:00:00Z",
    receitas: [
      {
        id: INSTANCIA,
        receita: "woocommerce-produtos",
        rotulo: "Produtos",
        descricao: "",
        fixos: { prefixo: "wp_" },
        ativa: true,
        ...instancia,
      },
    ],
    ...over,
  };
}

/** Dublê do CRM que APLICA os `eq` sobre as linhas — filtro esquecido devolve linha. */
function banco(linhas: Array<Record<string, unknown>>) {
  return {
    from: (tabela: string) => {
      if (tabela !== "external_db_connections") throw new Error(`tabela inesperada: ${tabela}`);
      const filtros: Array<[string, unknown]> = [];
      const cadeia = {
        select: () => cadeia,
        eq: (c: string, v: unknown) => (filtros.push([c, v]), cadeia),
        maybeSingle: async () => ({
          data: linhas.find((l) => filtros.every(([c, v]) => l[c] === v)) ?? null,
          error: null,
        }),
      };
      return cadeia;
    },
  };
}

function ctx(supabase: unknown, organizationId = ORG): McpContext {
  return {
    organizationId,
    role: "agent",
    actor: { type: "ai_agent", id: "agente-1" },
    apiTokenId: "tok-1",
    requestId: "req-1",
    supabase,
  } as unknown as McpContext;
}

const executar = (supabase: unknown, org = ORG, busca: unknown = { termos: ["camiseta"] }) =>
  crmConsultarReceita.handler(
    { acao: "executar", connection_id: CONEXAO, instancia_id: INSTANCIA, busca },
    ctx(supabase, org),
  ) as Promise<Record<string, unknown>>;

beforeEach(() => {
  vi.clearAllMocks();
  m.auditados.length = 0;
  m.modulo.mockResolvedValue(true);
  m.executar.mockResolvedValue({ colunas: ["id", "titulo"], linhas: [{ id: 1, titulo: "x" }], truncado: false });
});

describe("crm_consultar_receita executar — conferências antes de tocar o banco de origem", () => {
  it("controle: tudo em ordem, a receita roda uma vez", async () => {
    const r = await executar(banco([linha()]));
    expect(r).not.toHaveProperty("erro");
    expect(m.executar).toHaveBeenCalledTimes(1);
  });

  it("conexão de outra organização: não roda", async () => {
    const r = await executar(banco([linha({ organization_id: OUTRA_ORG })]));
    expect(r.erro).toBe("nao_encontrada");
    expect(m.executar).not.toHaveBeenCalled();
  });

  it("conexão desativada: não roda", async () => {
    const r = await executar(banco([linha({ enabled: false })]));
    expect(r).toHaveProperty("erro");
    expect(m.executar).not.toHaveBeenCalled();
  });

  it("módulo banco_externo desligado: não roda", async () => {
    m.modulo.mockResolvedValue(false);
    const r = await executar(banco([linha()]));
    expect(r).toHaveProperty("erro");
    expect(m.executar).not.toHaveBeenCalled();
  });

  it("instância de receita DESATIVADA pelo administrador: não roda", async () => {
    const r = await executar(banco([linha({}, { ativa: false })]));
    expect(r).toHaveProperty("erro");
    expect(m.executar).not.toHaveBeenCalled();
  });

  it("escopo `list` sem as tabelas da receita: fonte_nao_liberada, não roda", async () => {
    const r = await executar(
      banco([linha({ source_mode: "list", sources: [{ schema: "loja", tabela: "wp_users", colunas: null, descricao: "" }] })]),
    );
    expect(r.erro).toBe("fonte_nao_liberada");
    expect(m.executar).not.toHaveBeenCalled();
  });

  it("escopo `list` com uma coluna da receita escondida: não roda", async () => {
    const r = await executar(
      banco([
        linha({
          source_mode: "list",
          sources: [
            { schema: "loja", tabela: "wp_posts", colunas: ["ID", "post_title"], descricao: "" },
            { schema: "loja", tabela: "wp_postmeta", colunas: null, descricao: "" },
          ],
        }),
      ]),
    );
    expect(r.erro).toBe("fonte_nao_liberada");
    expect(m.executar).not.toHaveBeenCalled();
  });

  it("escopo `list` com tabelas e colunas liberadas: roda (controle do escopo)", async () => {
    const r = await executar(
      banco([
        linha({
          source_mode: "list",
          sources: [
            { schema: "loja", tabela: "wp_posts", colunas: null, descricao: "" },
            { schema: "loja", tabela: "wp_postmeta", colunas: null, descricao: "" },
          ],
        }),
      ]),
    );
    expect(r).not.toHaveProperty("erro");
    expect(m.executar).toHaveBeenCalledTimes(1);
  });
});

describe("crm_consultar_receita — audit registra o fato, não o conteúdo da busca", () => {
  it("os valores da busca não chegam ao metadata do audit (mesma regra dos dois ingressos)", async () => {
    const TERMO = "termo-sentinela-q7z";
    const PRECO = 98765.43;
    const args = {
      acao: "executar",
      connection_id: CONEXAO,
      instancia_id: INSTANCIA,
      busca: { termos: [TERMO], preco_max: PRECO },
    };
    // O que `lib/mcp/server.ts` e `lib/ai/runtime/tools.ts` fazem antes de auditar.
    const argsAudit = crmConsultarReceita.redigirParaAuditoria
      ? crmConsultarReceita.redigirParaAuditoria(args)
      : args;
    await auditMcpToolCall({
      ctx: ctx(banco([])),
      toolName: crmConsultarReceita.name,
      args: argsAudit,
      durationMs: 1,
      success: true,
    });

    expect(m.auditados).toHaveLength(1);
    const gravado = JSON.stringify(m.auditados[0]!.metadata);
    expect(gravado).not.toContain(TERMO);
    expect(gravado).not.toContain(String(PRECO));
    // O fato continua lá: qual receita, qual conexão.
    expect(gravado).toContain(INSTANCIA);
    expect(gravado).toContain(CONEXAO);
  });

  it("uma busca que não é objeto não chega ao audit nem como texto", () => {
    const TERMO = "termo-solto-k3w";
    const redigido = crmConsultarReceita.redigirParaAuditoria!({
      acao: "executar",
      connection_id: CONEXAO,
      instancia_id: INSTANCIA,
      busca: TERMO,
    });
    expect(JSON.stringify(redigido)).not.toContain(TERMO);
    expect(redigido.instancia_id).toBe(INSTANCIA);
  });
});
