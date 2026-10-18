import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
  acessar: vi.fn(),
  receitaDe: vi.fn(),
  lerReceitas: vi.fn(),
}));

vi.mock("@/lib/external-db/acesso", () => ({ abrirAcesso: deps.acessar }));
vi.mock("@/lib/external-db/receitas/registro", () => ({ receitaDe: deps.receitaDe }));
vi.mock("@/lib/external-db/receitas/instancias", () => ({ lerReceitasDoBanco: deps.lerReceitas }));

import { crmConsultarReceita } from "./receitas-externas";
import type { McpContext } from "@/lib/mcp/types";

const SENTINELA_ORG = "org-sentinela-isolamento";

function ctxFake(organizationId: string): McpContext & { __eqChamadas: Array<string[]> } {
  const eqChamadas: Array<string[]> = [];
  const chain = {
    select: () => chain,
    eq: (coluna: string, valor: unknown) => {
      eqChamadas.push([coluna, String(valor)]);
      return chain;
    },
    maybeSingle: async () => ({ data: null, error: null }),
  };
  return {
    organizationId,
    role: "agent",
    actor: { type: "ai_agent", id: "agent-1" },
    apiTokenId: "tok-1",
    requestId: "req-1",
    supabase: { from: () => chain },
    __eqChamadas: eqChamadas,
  } as unknown as McpContext & { __eqChamadas: Array<string[]> };
}

describe("crm_consultar_receita — isolamento por organização", () => {
  it("usa o organization_id do ctx na query (nunca do argumento)", async () => {
    const ctx = ctxFake(SENTINELA_ORG);
    await crmConsultarReceita.handler(
      { acao: "listar", connection_id: "conn-1" },
      ctx,
    );
    const orgChamada = ctx.__eqChamadas.find(([c]) => c === "organization_id");
    expect(orgChamada, "a query deve filtrar por organization_id").toBeDefined();
    expect(orgChamada![1]).toBe(SENTINELA_ORG);
  });
});

const CONEXAO = "44444444-4444-4444-8444-444444444444";
const INSTANCIA = "55555555-5555-4555-8555-555555555555";

function ctxComConexao(): McpContext {
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({
      data: { id: CONEXAO, db_type: "mysql", receitas: [] },
      error: null,
    }),
  };
  return {
    organizationId: SENTINELA_ORG,
    role: "agent",
    actor: { type: "ai_agent", id: "agent-1" },
    apiTokenId: "tok-1",
    requestId: "req-1",
    supabase: { from: () => chain },
  } as unknown as McpContext;
}

describe("crm_consultar_receita — executar", () => {
  const executarReceita = vi.fn();
  let montar: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    montar = vi.fn(() => ({ sql: "select 1", valores: [] }));
    deps.receitaDe.mockReturnValue({
      id: "r",
      motores: ["mysql"],
      parametrosDaBusca: { parse: (v: unknown) => v },
      tabelas: () => ["carros"],
      colunas: () => ({ carros: ["id", "ano"] }),
      montar,
      tetoDeItens: 5,
    });
    deps.lerReceitas.mockReturnValue({
      ok: true,
      instancias: [{ id: INSTANCIA, receita: "r", rotulo: "R", descricao: "", fixos: {}, ativa: true }],
    });
    deps.acessar.mockResolvedValue({ ok: true, dialeto: { executarReceita } });
  });

  it("coluna que não existe na tabela → { erro: 'coluna_inexistente' } citando a coluna", async () => {
    executarReceita.mockRejectedValue(
      Object.assign(new Error("coluna_inexistente:carros.ano"), { name: "LeituraInvalidaError" }),
    );
    const r = (await crmConsultarReceita.handler(
      { acao: "executar", connection_id: CONEXAO, instancia_id: INSTANCIA, busca: {} },
      ctxComConexao(),
    )) as { erro?: string; mensagem?: string };
    expect(r.erro).toBe("coluna_inexistente");
    expect(r.mensagem).toContain("ano");
  });

  it("receita DESLIGADA (ativa: false) não executa → nao_encontrada, sem tocar o dialeto", async () => {
    deps.lerReceitas.mockReturnValue({
      ok: true,
      instancias: [{ id: INSTANCIA, receita: "r", rotulo: "R", descricao: "", fixos: {}, ativa: false }],
    });
    const r = (await crmConsultarReceita.handler(
      { acao: "executar", connection_id: CONEXAO, instancia_id: INSTANCIA, busca: {} },
      ctxComConexao(),
    )) as { erro?: string };
    expect(r.erro).toBe("nao_encontrada");
    expect(deps.acessar).not.toHaveBeenCalled();
    expect(executarReceita).not.toHaveBeenCalled();
  });

  it("filtro sem coluna mapeada (montar lança filtro_sem_coluna:cidade) → { erro: 'filtro_sem_coluna' }", async () => {
    montar.mockImplementation(() => {
      throw Object.assign(new Error("filtro_sem_coluna:cidade"), { name: "LeituraInvalidaError" });
    });
    const r = (await crmConsultarReceita.handler(
      { acao: "executar", connection_id: CONEXAO, instancia_id: INSTANCIA, busca: { cidade: "x" } },
      ctxComConexao(),
    )) as { erro?: string; mensagem?: string };
    expect(r.erro).toBe("filtro_sem_coluna");
    expect(r.mensagem).toContain("cidade");
    expect(executarReceita).not.toHaveBeenCalled();
  });
});

describe("crm_consultar_receita — lê a TABELA, não a view _safe", () => {
  it("a coluna receitas não existe na view _safe (0697): a consulta vai a external_db_connections", async () => {
    const tabelas: string[] = [];
    const chain = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: async () => ({ data: null, error: null }),
    };
    const ctx = {
      organizationId: "org-x",
      role: "agent",
      actor: { type: "ai_agent", id: "a" },
      apiTokenId: "t",
      requestId: "r",
      supabase: { from: (t: string) => (tabelas.push(t), chain) },
    } as unknown as McpContext;
    await crmConsultarReceita.handler({ acao: "listar", connection_id: "conn-1" }, ctx);
    expect(tabelas).toEqual(["external_db_connections"]);
  });
});
