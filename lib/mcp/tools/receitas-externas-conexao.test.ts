import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as Registro from "@/lib/external-db/receitas/registro";

const mocks = vi.hoisted(() => ({ abrirAcesso: vi.fn(), receitaDe: vi.fn() }));

vi.mock("@/lib/external-db/acesso", () => ({ abrirAcesso: mocks.abrirAcesso }));
vi.mock("@/lib/external-db/receitas/registro", async (importOriginal) => ({
  ...(await importOriginal<typeof Registro>()),
  receitaDe: mocks.receitaDe,
}));

import { crmConsultarReceita } from "./receitas-externas";
import type { McpContext } from "@/lib/mcp/types";

const ORG = "org-1";
const ATIVA = "11111111-1111-4111-8111-111111111111";
const OUTRA_ATIVA = "22222222-2222-4222-8222-222222222222";
const INATIVA = "33333333-3333-4333-8333-333333333333";
const INSTANCIA_ID = "55555555-5555-4555-8555-555555555555";

const INSTANCIA = {
  id: INSTANCIA_ID,
  receita: "woocommerce-produtos",
  rotulo: "Produtos da loja",
  descricao: "",
  fixos: { prefixo: "wp_" },
  ativa: true,
};

const RECEITA = {
  id: "woocommerce-produtos",
  motores: ["mysql"],
  tetoDeItens: 5,
  parametrosDaBusca: { shape: {}, parse: (v: unknown) => v },
  tabelas: () => ["wp_posts"],
  colunas: () => ({ wp_posts: ["ID"] }),
  montar: vi.fn(() => ({ sql: "select ...", valores: [] as unknown[] })),
};

type Linha = {
  id: string;
  organization_id: string;
  label: string;
  db_type: string;
  enabled: boolean;
  receitas?: unknown;
  max_rows?: number;
};

/**
 * Dublê de `supabase` para `external_db_connections`. Aplica os filtros `eq`
 * recebidos, então `order` devolve a lista (resolução da conexão) e
 * `maybeSingle` devolve a linha única (leitura por id) — as duas formas que a
 * tool usa. Guarda as consultas para a caracterização do caminho explícito.
 */
function dubleDeConexoes(linhas: Linha[]) {
  const consultas: Array<{ tabela: string; filtros: Array<[string, unknown]> }> = [];
  const from = (tabela: string) => {
    if (tabela !== "external_db_connections") {
      throw new Error(`tabela inesperada: ${tabela}`);
    }
    const consulta = { tabela, filtros: [] as Array<[string, unknown]> };
    consultas.push(consulta);
    const filtrar = () =>
      linhas.filter((linha) =>
        consulta.filtros.every(
          ([coluna, valor]) => (linha as unknown as Record<string, unknown>)[coluna] === valor,
        ),
      );
    const chain = {
      select: () => chain,
      eq: (coluna: string, valor: unknown) => {
        consulta.filtros.push([coluna, valor]);
        return chain;
      },
      order: async () => ({ data: filtrar(), error: null }),
      maybeSingle: async () => ({ data: filtrar()[0] ?? null, error: null }),
    };
    return chain;
  };
  return { from, consultas };
}

function ctxCom(supabase: { from: (tabela: string) => unknown }): McpContext {
  return {
    organizationId: ORG,
    role: "agent",
    actor: { type: "ai_agent", id: "agent-1" },
    apiTokenId: "tok-1",
    requestId: "req-1",
    supabase,
  } as unknown as McpContext;
}

const ativa = (id: string, label: string): Linha => ({
  id,
  organization_id: ORG,
  label,
  db_type: "mysql",
  enabled: true,
  receitas: [INSTANCIA],
  max_rows: 200,
});

const inativa = (id: string, label: string): Linha => ({
  id,
  organization_id: ORG,
  label,
  db_type: "mysql",
  enabled: false,
  receitas: [INSTANCIA],
  max_rows: 200,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.receitaDe.mockReturnValue(RECEITA);
});

describe("crm_consultar_receita — uma conexão possível não é ambiguidade (#4763)", () => {
  it("uma conexão ativa e nenhuma outra: listar sem connection_id executa nela", async () => {
    const duble = dubleDeConexoes([ativa(ATIVA, "Matriz")]);
    const res = (await crmConsultarReceita.handler({ acao: "listar" }, ctxCom(duble))) as {
      erro?: string;
      conexao?: { id: string };
      receitas?: unknown[];
    };

    expect(res.erro).toBeUndefined();
    expect(res.conexao?.id).toBe(ATIVA);
    expect(res.receitas).toHaveLength(1);
  });

  it("duas ativas sem connection_id: recusa com conexao_ambigua", async () => {
    const duble = dubleDeConexoes([ativa(ATIVA, "Matriz"), ativa(OUTRA_ATIVA, "Filial")]);
    const res = (await crmConsultarReceita.handler({ acao: "listar" }, ctxCom(duble))) as {
      erro?: string;
      conexoes?: unknown[];
    };

    expect(res.erro).toBe("conexao_ambigua");
    expect(res.conexoes).toHaveLength(2);
  });

  it("uma ativa mais uma inativa: executa na ativa (a inativa não conta)", async () => {
    const duble = dubleDeConexoes([
      ativa(ATIVA, "Matriz"),
      inativa(INATIVA, "Antiga desligada"),
    ]);
    const res = (await crmConsultarReceita.handler({ acao: "listar" }, ctxCom(duble))) as {
      erro?: string;
      conexao?: { id: string };
    };

    expect(res.erro).toBeUndefined();
    expect(res.conexao?.id).toBe(ATIVA);
  });

  it("a recusa diz quantas conexões possíveis existem", async () => {
    const duble = dubleDeConexoes([
      ativa(ATIVA, "Matriz"),
      ativa(OUTRA_ATIVA, "Filial"),
      inativa(INATIVA, "Antiga desligada"),
    ]);
    const res = (await crmConsultarReceita.handler({ acao: "listar" }, ctxCom(duble))) as {
      erro?: string;
      mensagem?: string;
    };

    expect(res.erro).toBe("conexao_ambigua");
    expect(res.mensagem).toContain("2");
    expect(res.mensagem).toMatch(/connection_id/);
  });

  it("conexão única inativa: recusa por motivo próprio, não por ambiguidade", async () => {
    const duble = dubleDeConexoes([inativa(INATIVA, "Antiga desligada")]);
    const res = (await crmConsultarReceita.handler({ acao: "listar" }, ctxCom(duble))) as {
      erro?: string;
      mensagem?: string;
    };

    expect(res.erro).toBe("sem_conexao");
    expect(res.mensagem).toMatch(/desativada/);
  });

  it("conexão ativa de OUTRA empresa não entra na conta nem na lista da recusa", async () => {
    const DE_OUTRA_ORG = "44444444-4444-4444-8444-444444444444";
    const duble = dubleDeConexoes([
      ativa(ATIVA, "Matriz"),
      { ...ativa(DE_OUTRA_ORG, "Banco de outra empresa"), organization_id: "org-2" },
    ]);
    const res = await crmConsultarReceita.handler({ acao: "listar" }, ctxCom(duble));

    expect((res as { erro?: string }).erro).toBeUndefined();
    expect((res as { conexao?: { id: string } }).conexao?.id).toBe(ATIVA);
    expect(JSON.stringify(res)).not.toContain(DE_OUTRA_ORG);
  });

  it("com connection_id explícito o comportamento é o de hoje (usa o id, sem listar)", async () => {
    const duble = dubleDeConexoes([ativa(ATIVA, "Matriz")]);
    const res = (await crmConsultarReceita.handler(
      { acao: "listar", connection_id: ATIVA },
      ctxCom(duble),
    )) as { erro?: string; conexao?: { id: string } };

    expect(res.erro).toBeUndefined();
    expect(res.conexao?.id).toBe(ATIVA);
    // Caracterização: uma única consulta, por id — a lista de conexões não é lida.
    expect(duble.consultas).toHaveLength(1);
    expect(duble.consultas[0]!.filtros).toContainEqual(["id", ATIVA]);
  });
});
