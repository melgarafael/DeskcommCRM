/**
 * Pré-visualização de receita — o ESTADO da conexão é conferido antes de tocar o
 * banco de origem, e o teto de linhas é o mesmo da ferramenta do agente.
 *
 * Caminho real: `seModuloDesligado`, `abrirAcesso`, `carregarConexao`,
 * `criarDialetoDeLeitura` e a receita woocommerce. Dublês: o banco do CRM (que
 * APLICA os `eq`), a sessão, a cifra, o DNS e as operações do motor.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { OperacoesDoMotor } from "@/lib/external-db/dialeto";
import type { ConexaoExterna } from "@/lib/external-db/types";
import type { McpContext } from "@/lib/mcp/types";

const m = vi.hoisted(() => ({
  modulo: vi.fn(),
  executar: vi.fn(),
  admin: vi.fn(),
}));

vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: m.modulo }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: m.admin }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: async () => ({ allowed: true }) }));
vi.mock("@/lib/audit", () => ({ audit: async () => {} }));
vi.mock("@/lib/external-db/guardas", () => ({
  validarHostDeBanco: async () => ({ ok: true, enderecos: ["203.0.113.10"] }),
}));
vi.mock("@/lib/crypto/aes_gcm", async (orig) => ({
  ...(await orig<typeof import("@/lib/crypto/aes_gcm")>()),
  decryptKey: () => "senha",
  byteaToBuffer: () => Buffer.alloc(0),
}));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () => ({
    ok: true,
    user: { id: "u-1", idioma: "pt-BR" },
    org: { orgId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", role: "admin" },
  }),
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
          : ["ID", "post_title", "post_status", "post_type", "guid", "post_excerpt"],
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

import { crmConsultarReceita } from "@/lib/mcp/tools/receitas-externas";

import { POST } from "./route";

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
      { id: INSTANCIA, receita: "woocommerce-produtos", rotulo: "Produtos", descricao: "", fixos: { prefixo: "wp_" }, ativa: true, ...instancia },
    ],
    ...over,
  };
}

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

const previa = (busca: unknown = { termos: ["camiseta"] }) =>
  POST(
    new NextRequest(`http://localhost/api/v1/external-db/connections/${CONEXAO}/recipes/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instancia_id: INSTANCIA, busca }),
    }),
    { params: Promise.resolve({ id: CONEXAO }) },
  );

beforeEach(() => {
  vi.clearAllMocks();
  m.modulo.mockResolvedValue(true);
  m.executar.mockResolvedValue({ colunas: ["id"], linhas: [{ id: 1 }], truncado: false });
});

describe("POST recipes/preview — estado conferido antes do banco de origem", () => {
  it("controle: conexão ativa, módulo ligado → 200 e a receita roda uma vez", async () => {
    m.admin.mockReturnValue(banco([linha()]));
    const res = await previa();
    expect(res.status).toBe(200);
    expect(m.executar).toHaveBeenCalledTimes(1);
  });

  it("conexão desativada: não roda e não responde 200", async () => {
    m.admin.mockReturnValue(banco([linha({ enabled: false })]));
    const res = await previa();
    expect(res.status).not.toBe(200);
    expect(m.executar).not.toHaveBeenCalled();
  });

  it("módulo banco_externo desligado: 404 e não roda", async () => {
    m.modulo.mockResolvedValue(false);
    m.admin.mockReturnValue(banco([linha()]));
    const res = await previa();
    expect(res.status).toBe(404);
    expect(m.executar).not.toHaveBeenCalled();
  });

  it("conexão de outra organização: 404 e não roda", async () => {
    m.admin.mockReturnValue(banco([linha({ organization_id: OUTRA_ORG })]));
    const res = await previa();
    expect(res.status).toBe(404);
    expect(m.executar).not.toHaveBeenCalled();
  });

  it("escopo `list` sem as tabelas da receita: 422 fonte_nao_liberada, não roda", async () => {
    m.admin.mockReturnValue(
      banco([linha({ source_mode: "list", sources: [{ schema: "loja", tabela: "wp_users", colunas: null, descricao: "" }] })]),
    );
    const res = await previa();
    expect(res.status).toBe(422);
    expect(m.executar).not.toHaveBeenCalled();
  });

  it("o teto de linhas (limiteMax) é o MESMO da ferramenta do agente, para a mesma conexão e busca", async () => {
    const busca = { termos: ["camiseta", "sorvete", "boné"], limite: 4 };
    const conexao = linha({ max_rows: 7 });

    m.admin.mockReturnValue(banco([conexao]));
    await previa(busca);
    const daPrevia = m.executar.mock.calls[0]![1];

    m.executar.mockClear();
    await crmConsultarReceita.handler(
      { acao: "executar", connection_id: CONEXAO, instancia_id: INSTANCIA, busca },
      { organizationId: ORG, role: "agent", actor: { type: "ai_agent", id: "a" }, apiTokenId: "t", requestId: "r", supabase: banco([conexao]) } as unknown as McpContext,
    );
    const daFerramenta = m.executar.mock.calls[0]![1];

    expect(daPrevia).toEqual(daFerramenta);
    expect(daPrevia.limiteMax).toBe(7);
  });

  it("instância INATIVA: a prévia roda (por desenho — o admin testa antes de ativar; a tela oferece o botão)", async () => {
    m.admin.mockReturnValue(banco([linha({}, { ativa: false })]));
    const res = await previa();
    expect(res.status).toBe(200);
    expect(m.executar).toHaveBeenCalledTimes(1);
  });
});
