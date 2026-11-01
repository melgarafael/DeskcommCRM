import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as Registro from "@/lib/external-db/receitas/registro";

const mocks = vi.hoisted(() => ({ abrirAcesso: vi.fn(), receitaDe: vi.fn() }));

vi.mock("@/lib/external-db/acesso", () => ({ abrirAcesso: mocks.abrirAcesso }));
// O resto do registro é o real: `lerReceitasDoBanco` precisa de IDS_DAS_RECEITAS.
vi.mock("@/lib/external-db/receitas/registro", async (importOriginal) => ({
  ...(await importOriginal<typeof Registro>()),
  receitaDe: mocks.receitaDe,
}));

import { crmConsultarReceita } from "./receitas-externas";
import type { McpContext } from "@/lib/mcp/types";

const SENTINELA_ORG = "org-sentinela-isolamento";
const CONEXAO = "11111111-1111-4111-8111-111111111111";
const INSTANCIA_ID = "55555555-5555-4555-8555-555555555555";

const INSTANCIA = {
  id: INSTANCIA_ID,
  receita: "woocommerce-produtos",
  rotulo: "Produtos da loja WooCommerce",
  descricao: "",
  fixos: { prefixo: "wp_" },
  ativa: true,
};

const RECEITA = {
  id: "woocommerce-produtos",
  motores: ["mysql"],
  tetoDeItens: 5,
  parametrosDaBusca: { parse: (v: unknown) => v },
  tabelas: () => ["wp_posts"],
  colunas: () => ({ wp_posts: ["ID", "post_title"] }),
  montar: vi.fn((_fixos: unknown, _busca: unknown, _limiteItens: number) => ({
    sql: "select ...",
    valores: [] as unknown[],
  })),
};

/** Dublê de supabase que só aceita ler da tabela `external_db_connections`. */
function supabaseDuble(eqChamadas: Array<string[]>, conexao: unknown) {
  const chain = {
    select: () => chain,
    eq: (coluna: string, valor: unknown) => {
      eqChamadas.push([coluna, String(valor)]);
      return chain;
    },
    maybeSingle: async () => ({ data: conexao, error: null }),
  };
  return {
    from: (tabela: string) => {
      if (tabela !== "external_db_connections") {
        throw new Error(`tabela inesperada: ${tabela}`);
      }
      return chain;
    },
  };
}

function ctxComSupabase(
  organizationId: string,
  supabase: ReturnType<typeof supabaseDuble>,
  eqChamadas: Array<string[]>,
): McpContext & { eqChamadas: Array<string[]> } {
  return {
    organizationId,
    role: "agent",
    actor: { type: "ai_agent", id: "agent-1" },
    apiTokenId: "tok-1",
    requestId: "req-1",
    supabase,
    eqChamadas,
  } as unknown as McpContext & { eqChamadas: Array<string[]> };
}

describe("crm_consultar_receita — isolamento por organização", () => {
  it("usa o organization_id do ctx na query (nunca do argumento)", async () => {
    const eqChamadas: Array<string[]> = [];
    const ctx = ctxComSupabase(
      SENTINELA_ORG,
      supabaseDuble(eqChamadas, null),
      eqChamadas,
    );

    await crmConsultarReceita.handler(
      { acao: "listar", connection_id: "conn-1" },
      ctx,
    );
    const orgChamada = ctx.eqChamadas.find(([c]) => c === "organization_id");
    expect(orgChamada, "a query deve filtrar por organization_id").toBeDefined();
    expect(orgChamada![1]).toBe(SENTINELA_ORG);
  });

  it("ler de qualquer outra tabela lança (dublê confere a tabela)", async () => {
    const eqChamadas: Array<string[]> = [];
    const ctx = ctxComSupabase(
      SENTINELA_ORG,
      supabaseDuble(eqChamadas, null),
      eqChamadas,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const from = (ctx.supabase as any).from;
    expect(() => from("external_db_connections_safe")).toThrow(/tabela inesperada/);
  });
});

describe("crm_consultar_receita — execução respeita limite e max_rows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.receitaDe.mockReturnValue(RECEITA);
  });

  it("max_rows da conexão menor que o teto: o limiteMax passado ao dialeto respeita o max_rows", async () => {
    const executarReceita = vi.fn(async (_consulta: unknown, _opcoes: { limiteMax?: number }) => ({
      colunas: ["id", "titulo"],
      linhas: [] as unknown[],
      truncado: false,
    }));
    mocks.abrirAcesso.mockResolvedValue({ ok: true, dialeto: { executarReceita } });

    const conexao = { id: CONEXAO, db_type: "mysql", receitas: [INSTANCIA], max_rows: 3 };
    const eqChamadas: Array<string[]> = [];
    const ctx = ctxComSupabase(
      "org-1",
      supabaseDuble(eqChamadas, conexao),
      eqChamadas,
    );

    const res = await crmConsultarReceita.handler(
      {
        acao: "executar",
        connection_id: CONEXAO,
        instancia_id: INSTANCIA_ID,
        busca: { termos: ["camisa"] },
      },
      ctx,
    );

    expect(res).not.toHaveProperty("erro");
    expect(executarReceita).toHaveBeenCalledTimes(1);
    expect(executarReceita.mock.calls[0]![1].limiteMax).toBe(3);
  });

  it("limite pedido menor que o teto: montar recebe esse limite", async () => {
    const executarReceita = vi.fn(async (_consulta: unknown, _opcoes: { limiteMax?: number }) => ({
      colunas: ["id", "titulo"],
      linhas: [] as unknown[],
      truncado: false,
    }));
    mocks.abrirAcesso.mockResolvedValue({ ok: true, dialeto: { executarReceita } });

    const conexao = { id: CONEXAO, db_type: "mysql", receitas: [INSTANCIA], max_rows: 200 };
    const eqChamadas: Array<string[]> = [];
    const ctx = ctxComSupabase(
      "org-1",
      supabaseDuble(eqChamadas, conexao),
      eqChamadas,
    );

    await crmConsultarReceita.handler(
      {
        acao: "executar",
        connection_id: CONEXAO,
        instancia_id: INSTANCIA_ID,
        busca: { limite: 2, termos: ["camisa"] },
      },
      ctx,
    );

    expect(RECEITA.montar).toHaveBeenCalledTimes(1);
    expect(RECEITA.montar.mock.calls[0]![2]).toBe(2);
  });
});
