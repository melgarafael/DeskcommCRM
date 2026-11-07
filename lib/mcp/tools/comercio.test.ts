import { describe, expect, it } from "vitest";

import { crmSearchProducts } from "./comercio";
import type { McpContext } from "../types";

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
 * O SERVIÇO NA BUSCA — issue #3372, fatia E.
 *
 * A IA não ganha ferramenta nova: o serviço sai pelo `crm_search_products`, que
 * já é onde ela busca preço. O que a resposta precisa levar é o que a #2497 não
 * levava — tipo, "a partir de", variações com preço, sinal calculado, prazo e as
 * instruções internas MARCADAS. Sem isso, "quanto é o sinal?" e "o que vem
 * incluso?" ficam sem resposta e o modelo completa com o que lembrou.
 */

const SERVICO_SOCIAL = {
  id: "11111111-1111-4111-8111-111111111111",
  codigo: "SOCIAL",
  nome: "Social media",
  descricao: "Gestão de redes sociais",
  marca: null,
  categoria: null,
  preco_cents: 120_000,
  moeda: "BRL",
  controla_estoque: false,
  quantidade: 0,
  ativo: true,
  fotos: null,
  tipo_servico: "recorrente",
  unidade_cobranca: "mes",
  prazo_dias_uteis: null,
  sinal_tipo: "percentual",
  sinal_percentual: 30,
  sinal_cents: null,
  pai_id: null,
  instrucoes_ia: "Nunca prometer prazo menor que 30 dias.",
  ia_oferece: true,
  ia_agenda: false,
  revision: 2,
};

const VARIACAO_SOCIAL = {
  ...SERVICO_SOCIAL,
  id: "22222222-2222-4222-8222-222222222222",
  codigo: "SOCIAL-20",
  nome: "Social media 20 posts e 4 reels",
  preco_cents: 190_000,
  tipo_servico: null,
  unidade_cobranca: null,
  sinal_tipo: null,
  sinal_percentual: null,
  pai_id: SERVICO_SOCIAL.id,
};

interface ProdutoComServico {
  preco: string;
  servico?: {
    tipo?: string;
    unidade?: string;
    preco_a_partir?: string;
    prazo_dias_uteis?: number;
    sinal?: string;
    sinal_cents?: number;
    agendamento?: string;
    instrucoes_internas_nao_repita_ao_cliente?: string;
    variacoes?: Array<{ nome: string; preco: string; preco_cents: number }>;
  };
}

describe("crm_search_products — serviço no catálogo (#3372)", () => {
  it("devolve o serviço com 'a partir de', variações e sinal calculado", async () => {
    const resultado = (await crmSearchProducts.handler(
      { termo: "social media", limite: 8, somente_disponiveis: true },
      ctxCom([SERVICO_SOCIAL, VARIACAO_SOCIAL]),
    )) as { produtos: ProdutoComServico[] };

    expect(resultado.produtos).toHaveLength(1);
    const servico = resultado.produtos[0]!.servico!;
    expect(servico.tipo).toBe("plano recorrente");
    expect(semNbsp(servico.preco_a_partir ?? "")).toBe("a partir de R$ 1.200,00 por mês");
    expect(servico.variacoes).toHaveLength(1);
    expect(servico.variacoes![0]!.nome).toBe("Social media 20 posts e 4 reels");
    expect(semNbsp(servico.variacoes![0]!.preco)).toBe("R$ 1.900,00 por mês");
    // 30% de R$ 1.200,00 — calculado, não copiado.
    expect(semNbsp(servico.sinal ?? "")).toBe("sinal de R$ 360,00 (30%)");
    expect(servico.sinal_cents).toBe(36_000);
  });

  it("a variação não sai como um segundo item solto: o principal é o que se vende", async () => {
    const resultado = (await crmSearchProducts.handler(
      { termo: "social media 20 posts", limite: 8, somente_disponiveis: true },
      ctxCom([SERVICO_SOCIAL, VARIACAO_SOCIAL]),
    )) as { produtos: ProdutoComServico[] };

    // O termo casou a VARIAÇÃO; quem responde é o principal, com ela dentro.
    expect(resultado.produtos).toHaveLength(1);
    expect(resultado.produtos[0]!.servico?.tipo).toBe("plano recorrente");
  });

  it("as instruções internas chegam MARCADAS para o modelo não repetir ao cliente", async () => {
    const resultado = (await crmSearchProducts.handler(
      { termo: "social", limite: 8, somente_disponiveis: true },
      ctxCom([SERVICO_SOCIAL]),
    )) as { produtos: ProdutoComServico[] };

    expect(resultado.produtos[0]!.servico?.instrucoes_internas_nao_repita_ao_cliente).toBe(
      "Nunca prometer prazo menor que 30 dias.",
    );
    // E o serviço que a IA não agenda diz que a equipe marca.
    expect(String(resultado.produtos[0]!.servico?.agendamento)).toContain("a equipe marca");
  });

  it("produto de prateleira continua sem o bloco de serviço", async () => {
    const resultado = (await crmSearchProducts.handler(
      { termo: "iphone", limite: 8, somente_disponiveis: true },
      ctxCom([PRODUTO_MXN]),
    )) as { produtos: ProdutoComServico[] };

    expect(resultado.produtos[0]!.servico).toBeUndefined();
  });
});
