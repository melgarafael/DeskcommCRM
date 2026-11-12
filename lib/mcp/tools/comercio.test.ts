import { beforeEach, describe, expect, it, vi } from "vitest";

import { crmSearchProducts } from "./comercio";
import type { McpContext } from "../types";
import { moduloLigadoComMemo } from "@/lib/instalacao/modulos";

vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigadoComMemo: vi.fn(async () => false) }));
beforeEach(() => vi.mocked(moduloLigadoComMemo).mockResolvedValue(false));

/** Só o formato do campo que este arquivo mede — não o contrato inteiro. */
interface RespostaBusca {
  produtos: Array<{ preco: string }>;
}

/**
 * O PREÇO QUE O AGENTE COTA AO CLIENTE — NA CONVENÇÃO DA MOEDA DA LOJA.
 *
 * `precoLegivel()` era uma SEXTA cópia de formatador de dinheiro, não
 * declarada no comentário de `lib/money.ts` que lista as cinco conhecidas — e
 * a mais grave das seis: é o texto que `crm_search_products` devolve ao
 * agente, que é quem fala com o cliente por WhatsApp. A pantalla de Produtos
 * já mostrava `$249.90` para uma loja em MXN; o agente, com `precoLegivel`,
 * continuava dizendo `MXN 249,90` — o mesmo defeito que a migration 0208
 * documenta ter corrigido, sobrevivendo no único canal que fala com o
 * cliente de verdade.
 */

function ctxCom(produtos: Array<Record<string, unknown>>): McpContext {
  const query = {
    select: () => query,
    eq: () => query,
    order: () => query,
    range: async () => ({ data: produtos, error: null, count: produtos.length }),
  };
  return {
    organizationId: "22222222-2222-4222-8222-222222222222",
    role: "agent",
    actor: { type: "ai_agent", id: "run-1", agent_id: "agent-1" },
    apiTokenId: "33333333-3333-4333-8333-333333333333",
    requestId: "44444444-4444-4444-8444-444444444444",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: { from: () => query } as any,
  } as McpContext;
}


/** O `Intl` emite NBSP (U+00A0) ou narrow NBSP (U+202F) entre símbolo e número. */
const semNbsp = (s: string) => s.replace(/[\u00A0\u202F]/g, " ");

const PRODUTO_MXN = {
  id: "11111111-1111-4111-8111-111111111111",
  codigo: "IP15",
  nome: "iPhone 15",
  descricao: null,
  marca: null,
  categoria: null,
  preco_cents: 24990,
  moeda: "MXN",
  controla_estoque: false,
  quantidade: 0,
  ativo: true,
};

describe("crm_search_products — preço na convenção da moeda", () => {
  it("cota o preço em MXN como um comerciante mexicano lê, não em pt-BR", async () => {
    const resultado = (await crmSearchProducts.handler(
      { termo: "iphone", limite: 8, somente_disponiveis: true },
      ctxCom([PRODUTO_MXN]),
    )) as RespostaBusca;

    expect(resultado.produtos).toHaveLength(1);
    // Ponto decimal e cifrão — não `MXN 249,90`, que era o que precoLegivel()
    // devolvia (vírgula decimal brasileira com o código colado na frente).
    expect(resultado.produtos[0]!.preco).toBe("$249.90");
    expect(resultado.produtos[0]!.preco).not.toContain("MXN 249,90");
  });

  it("continua certo em BRL — a troca não pode mudar o que já funcionava", async () => {
    const resultado = (await crmSearchProducts.handler(
      { termo: "iphone", limite: 8, somente_disponiveis: true },
      ctxCom([{ ...PRODUTO_MXN, moeda: "BRL" }]),
    )) as RespostaBusca;

    expect(semNbsp(resultado.produtos[0]!.preco)).toBe("R$ 249,90");
  });
});

/**
 * O SERVIÇO NA BUSCA — issue #3372, fatia E, no desenho do doc 212.
 *
 * O serviço é o módulo opcional `catalogo_servicos`. Desligado, a busca é a de
 * sempre — nenhuma consulta nova, nenhum campo novo, a mesma descrição da
 * ferramenta. Ligado, os detalhes do módulo decidem quem a IA oferece e o que
 * ela responde sobre "a partir de", sinal e prazo.
 */

const SOCIAL = {
  id: "aaaaaaaa-1111-4111-8111-111111111111",
  codigo: "SOCIAL",
  nome: "Social media",
  descricao: "Gestão de redes sociais",
  marca: null,
  categoria: null,
  preco_cents: 120_000,
  moeda: "BRL",
  // A tela de produtos pode marcar estoque num serviço; ele não some por isso.
  controla_estoque: true,
  quantidade: 0,
  ativo: true,
  fotos: null,
};
const SOCIAL_20 = { ...SOCIAL, id: "aaaaaaaa-2222-4222-8222-222222222222", codigo: "SOCIAL-20", nome: "Social media 20 posts e 4 reels", preco_cents: 190_000 };

const DETALHES = [
  {
    product_id: SOCIAL.id,
    pai_product_id: null,
    tipo: "recorrente",
    unidade: "mes",
    prazo_dias_uteis: null,
    sinal_tipo: "percentual",
    sinal_percentual: "30.00",
    sinal_cents: null,
    instrucoes_ia: "Nunca prometer prazo menor que 30 dias.",
    ia_oferece: true,
    revision: 2,
  },
  {
    product_id: SOCIAL_20.id,
    pai_product_id: SOCIAL.id,
    tipo: null,
    unidade: null,
    prazo_dias_uteis: null,
    sinal_tipo: null,
    sinal_percentual: null,
    sinal_cents: null,
    instrucoes_ia: null,
    ia_oferece: true,
    revision: 1,
  },
];

/** Duas tabelas: o catálogo e o detalhe do módulo. Registra cada `from` e `select`. */
function ctxComModulo(
  produtos: Array<Record<string, unknown>>,
  detalhes: { data: unknown[] | null; error: { message: string } | null },
) {
  const chamadas: Array<{ tabela: string; select: string }> = [];
  const supabase = {
    from: (tabela: string) => {
      const q = {
        select: (cols: string) => {
          chamadas.push({ tabela, select: cols });
          return q;
        },
        eq: () => q,
        order: () => q,
        range: async () =>
          tabela === "catalog_products"
            ? { data: produtos, error: null, count: produtos.length }
            : detalhes,
      };
      return q;
    },
  };
  const ctx = { ...ctxCom([]), supabase } as unknown as McpContext;
  return { ctx, chamadas };
}

interface ProdutoComServico {
  codigo: string;
  disponivel: boolean;
  servico?: Record<string, unknown> & { variacoes?: Array<{ nome: string; preco: string }> };
}

describe("crm_search_products — catálogo de serviços (módulo opcional)", () => {
  it("DESLIGADO: só o catálogo é consultado, com as colunas de sempre, e a resposta não ganha campo", async () => {
    const { ctx, chamadas } = ctxComModulo([SOCIAL, SOCIAL_20], { data: DETALHES, error: null });
    const r = (await crmSearchProducts.handler({ termo: "social media", limite: 8, somente_disponiveis: false }, ctx)) as Record<string, unknown> & { produtos: ProdutoComServico[] };

    expect(chamadas).toEqual([
      {
        tabela: "catalog_products",
        select: "id, codigo, nome, descricao, marca, categoria, preco_cents, moeda, controla_estoque, quantidade, ativo, fotos",
      },
    ]);
    // A variação é só mais um produto, como hoje; nenhum bloco de serviço.
    expect(r.produtos.map((p) => p.codigo).sort()).toEqual(["SOCIAL", "SOCIAL-20"]);
    expect(r.produtos.every((p) => p.servico === undefined)).toBe(true);
    expect(r.instrucoes_servico).toBeUndefined();
  });

  it("a descrição da ferramenta não fala de serviço: ela é a mesma ligado ou desligado", () => {
    expect(crmSearchProducts.description).not.toContain("servico");
  });

  it("LIGADO: o principal responde com 'a partir de', variações e sinal, e o serviço não some por estoque", async () => {
    vi.mocked(moduloLigadoComMemo).mockResolvedValue(true);
    const { ctx } = ctxComModulo([SOCIAL, SOCIAL_20], { data: DETALHES, error: null });
    const r = (await crmSearchProducts.handler({ termo: "social media 20 posts", limite: 8, somente_disponiveis: true }, ctx)) as Record<string, unknown> & { produtos: ProdutoComServico[] };

    expect(r.produtos).toHaveLength(1);
    const p = r.produtos[0]!;
    expect(p.codigo).toBe("SOCIAL");
    expect(p.disponivel).toBe(true);
    expect(semNbsp(String(p.servico?.preco_a_partir))).toBe("a partir de R$ 1.200,00 por mês");
    expect(p.servico?.variacoes?.map((v) => v.nome)).toEqual(["Social media 20 posts e 4 reels"]);
    expect(semNbsp(String(p.servico?.sinal))).toBe("sinal de R$ 360,00 (30%)");
    expect(p.servico?.instrucoes_internas_nao_repita_ao_cliente).toBe("Nunca prometer prazo menor que 30 dias.");
    expect(String(r.instrucoes_servico)).toContain("instrucoes_internas_nao_repita_ao_cliente");
  });

  it("LIGADO: ia_oferece=false no principal tira a família — nem pelo nome da variação ela volta", async () => {
    vi.mocked(moduloLigadoComMemo).mockResolvedValue(true);
    const desligado = [{ ...DETALHES[0]!, ia_oferece: false }, DETALHES[1]!];
    const { ctx } = ctxComModulo([SOCIAL, SOCIAL_20], { data: desligado, error: null });
    const r = (await crmSearchProducts.handler({ termo: "social media 20 posts", limite: 8, somente_disponiveis: false }, ctx)) as { produtos: unknown[]; motivo?: string };

    expect(r.produtos).toEqual([]);
    expect(r.motivo).toBe("nao_encontrado");
  });

  it("LIGADO: erro ao ler os detalhes FALHA a busca, em vez de oferecer o que pode estar desligado", async () => {
    vi.mocked(moduloLigadoComMemo).mockResolvedValue(true);
    const { ctx } = ctxComModulo([SOCIAL, SOCIAL_20], { data: null, error: { message: "boom" } });
    await expect(
      crmSearchProducts.handler({ termo: "social", limite: 8, somente_disponiveis: false }, ctx),
    ).rejects.toThrow("boom");
  });
});
