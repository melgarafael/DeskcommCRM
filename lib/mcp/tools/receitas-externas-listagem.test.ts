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
    supabase: { from: () => chain },
  } as unknown as McpContext;
}

describe("crm_consultar_receita listar: tipos dos parâmetros (Zod 4)", () => {
  it("acf-imoveis devolve preco_max: number e bairro: string (nunca 'desconhecido')", async () => {
    const ctx = ctxCom([
      {
        id: INSTANCIA,
        receita: "acf-imoveis",
        rotulo: "Imóveis",
        descricao: "",
        fixos: { prefixo: "wp_", post_type: "imovel", campos: { preco: "preco", quartos: "quartos", bairro: "bairro" } },
        ativa: true,
      },
    ]);
    const r = (await crmConsultarReceita.handler({ acao: "listar", connection_id: CONEXAO }, ctx)) as {
      receitas: Array<{ parametrosDaBusca: { campos: Array<{ nome: string; tipo: string }> } }>;
    };
    const campos = Object.fromEntries(r.receitas[0]!.parametrosDaBusca.campos.map((c) => [c.nome, c.tipo]));
    expect(campos.preco_max).toBe("number");
    expect(campos.bairro).toBe("string");
    expect(campos.quartos_min).toBe("number");
    expect(Object.values(campos)).not.toContain("desconhecido");
  });
});
