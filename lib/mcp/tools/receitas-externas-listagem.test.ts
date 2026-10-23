/**
 * `crm_consultar_receita` / listar: o agente precisa ver o TIPO de cada parâmetro.
 * Registro e instâncias são os REAIS (sem dublê de receita): o defeito era o
 * agente ler `_def.typeName` (Zod 3) num projeto em Zod 4, e todo campo virava "desconhecido".
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/external-db/acesso", () => ({ abrirAcesso: vi.fn() }));

import type { McpContext } from "@/lib/mcp/types";
import { crmConsultarReceita } from "./receitas-externas";

const CONEXAO = "11111111-1111-4111-8111-111111111111";
const INSTANCIA = "55555555-5555-4555-8555-555555555555";

function ctxCom(receitas: unknown[]): McpContext {
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({ data: { id: CONEXAO, db_type: "mysql", receitas }, error: null }),
  };
  return {
    organizationId: "org-1",
    role: "agent",
    actor: { type: "ai_agent", id: "a" },
    apiTokenId: "t",
    requestId: "r",
    supabase: {
      from: (tabela: string) => {
        if (tabela !== "external_db_connections") {
          throw new Error(`tabela inesperada: ${tabela}`);
        }
        return chain;
      },
    },
  } as unknown as McpContext;
}

describe("crm_consultar_receita listar: tipos dos parâmetros (Zod 4)", () => {
  it("woocommerce-produtos devolve tipos reais dos parâmetros (nunca 'desconhecido')", async () => {
    const ctx = ctxCom([
      {
        id: INSTANCIA,
        receita: "woocommerce-produtos",
        rotulo: "Produtos da loja WooCommerce",
        descricao: "",
        fixos: { prefixo: "wp_" },
        ativa: true,
      },
    ]);
    const r = (await crmConsultarReceita.handler({ acao: "listar", connection_id: CONEXAO }, ctx)) as {
      receitas: Array<{ parametrosDaBusca: { campos: Array<{ nome: string; tipo: string }> } }>;
    };
    const campos = Object.fromEntries(r.receitas[0]!.parametrosDaBusca.campos.map((c) => [c.nome, c.tipo]));
    expect(campos.termos).toBe("array");
    expect(campos.preco_max).toBe("number");
    expect(campos.so_em_estoque).toBe("boolean");
    expect(campos.limite).toBe("number");
    expect(Object.values(campos)).not.toContain("desconhecido");
  });
});
