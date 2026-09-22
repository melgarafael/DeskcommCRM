/**
 * Capacidades de COMÉRCIO — o que o cliente já comprou e o que existe à venda.
 *
 * Ficou de fora do épico até ser cobrado, e era a lacuna mais direta do pilar 1:
 * um agente de vendas que não enxerga o catálogo nem o histórico de pedidos
 * negocia no escuro — promete o que não existe, ou repete uma oferta que o
 * cliente já comprou.
 *
 * Service role bypassa RLS: TODA query filtra `organization_id` manualmente, e a
 * fonte é sempre `ctx.organizationId` (token/cookie), NUNCA o input.
 */
import { z } from "zod";

import type { McpToolDefinition } from "../types";
import { buscarComRelaxamento } from "@/lib/catalogo/busca";
import { criarPedidoComercial } from "@/lib/comercial/criar-pedido";
import { precoDeVitrine } from "@/lib/schemas/produtos";

// ---------------------------------------------------------------------------
// pedidos de um cliente
// ---------------------------------------------------------------------------

const pedidosInputShape = {
  contact_id: z.string().uuid().describe("O cliente cujos pedidos se quer ver."),
  limite: z.number().int().min(1).max(20).optional().default(10),
};

export const crmListContactOrders: McpToolDefinition<typeof pedidosInputShape> = {
  name: "crm_list_contact_orders",
  description:
    "Lista os pedidos de um contato, do mais recente para o mais antigo, com status, valor, " +
    "forma de pagamento, situação de entrega e código de rastreio. Use antes de prometer prazo " +
    "ou repetir oferta: o cliente pode já ter comprado.",
  inputSchema: pedidosInputShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    const { data, error } = await ctx.supabase
      .from("orders")
      .select(
        "id, external_id, external_provider, status, total_cents, currency, payment_method, fulfillment_status, tracking_code, ordered_at, is_anonymized",
      )
      .eq("organization_id", ctx.organizationId)
      .eq("contact_id", input.contact_id)
      .order("ordered_at", { ascending: false, nullsFirst: false })
      .limit(input.limite);

    if (error) throw new Error(`listar_pedidos_falhou: ${error.message}`);

    return {
      pedidos: (data ?? []).map((p) => ({
        ...p,
        // Pedido anonimizado por LGPD continua contando para histórico, mas o
        // conteúdo não volta: dizer isso é melhor que devolver campos vazios e
        // deixar o modelo concluir que o cliente nunca comprou.
        ...(p.is_anonymized ? { aviso: "pedido anonimizado a pedido do titular" } : {}),
      })),
    };
  },
};

// ---------------------------------------------------------------------------
// buscar no catálogo
// ---------------------------------------------------------------------------

const produtosInputShape = {
  termo: z
    .string()
    .trim()
    .min(2)
    .describe("o que a pessoa disse — pode ser o nome, a marca, o código ou tudo junto"),
  limite: z.number().int().min(1).max(20).optional().default(8),
  somente_disponiveis: z.boolean().optional().default(true),
};

/** O preço como a pessoa lê, não como o banco guarda. */
function precoLegivel(cents: number, moeda: string): string {
  const valor = (cents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 });
  return moeda === "BRL" ? `R$ ${valor}` : `${moeda} ${valor}`;
}

/**
 * O aviso que a busca manda junto com o resultado.
 *
 * ⚠️ OS DOIS SOMAM, NÃO SE EXCLUEM — e a ordem importa. Eram `if/else` com o
 * empate ganhando, e a precedência reabria justamente o buraco que o
 * relaxamento veio fechar. Medido: "iphone 15 pro 512" numa loja sem nenhum 512
 * relaxa, acha o 128 e o 256, os dois empatam em 1.000 — e o agente recebia
 * "pergunte qual é" em vez de "não há 512 aqui". Ele perguntaria "128 ou 256?"
 * a quem pediu 512.
 *
 * E não é coincidência rara: os dois coincidem SEMPRE que a variante ausente
 * empata os candidatos restantes, que é o formato do caso.
 *
 * O relaxamento vem primeiro porque é a restrição mais forte: saber que a loja
 * não tem o que foi pedido muda a resposta inteira; saber qual dos dois é
 * apenas a próxima pergunta.
 */
/**
 * Tamanho da página da varredura do catálogo.
 *
 * 1000 é o `max_rows` declarado em `supabase/config.toml:12` — pedir mais numa
 * página não traz mais nada, o servidor corta de qualquer jeito.
 */
const TAMANHO_DA_PAGINA = 1000;

/**
 * Teto DECLARADO da varredura: 10 páginas = 10 000 produtos.
 *
 * O teto existe porque a pontuação roda em memória e um catálogo sem limite
 * puxaria a loja inteira a cada pergunta de preço. O que muda em relação ao
 * `.limit(2000)` anterior não é só o número: é que estourar este teto agora
 * PRODUZ UM SINAL (`varreduraParcial`) em vez de virar silêncio.
 */
const PAGINAS_MAXIMAS = 10;

export function avisosDaBusca(input: { empate: boolean; ignorados: readonly string[] }): string {
  const avisos: string[] = [];
  if (input.ignorados.length > 0) {
    avisos.push(
      `não há produto com ${input.ignorados.join(" nem ")} no catálogo desta loja. ` +
        "O que está aqui foi encontrado IGNORANDO esse número. Se ele era a capacidade, o " +
        "tamanho ou o modelo que a pessoa pediu, diga que a loja não tem essa opção — " +
        "NÃO responda o preço destes como se fossem o que ela pediu. Se era quantidade ou " +
        "orçamento, siga normalmente.",
    );
  }
  if (input.empate) {
    avisos.push(
      "mais de um produto casa igualmente o que a pessoa disse, e o preço deles é diferente. " +
        "Pergunte qual é antes de responder valor.",
    );
  }
  return avisos.join(" ");
}

export const crmSearchProducts: McpToolDefinition<typeof produtosInputShape> = {
  name: "crm_search_products",
  description:
    "Busca no catálogo da loja e devolve o PREÇO EXATO, o que está disponível e o código de cada " +
    "produto. Use SEMPRE que a pessoa perguntar preço, e responda com o valor que voltar aqui — " +
    "nunca com um valor que você lembra ou estima: preço errado dito a um cliente é promessa que a " +
    "loja terá de cumprir ou desfazer. " +
    "Passe o que a pessoa escreveu, do jeito que ela escreveu: a busca entende erro de digitação " +
    "('ifone') e acha por marca, categoria ou código. " +
    "⚠️ SE VOLTAR MAIS DE UM produto com `empate: true`, NÃO escolha por conta própria — os dois " +
    "casam igualmente o que ela disse, e a diferença entre eles é de preço. Pergunte qual é. " +
    "Lista vazia significa que a loja não tem esse item cadastrado: não invente, ofereça consultar " +
    "com a equipe.",
  inputSchema: produtosInputShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    // Traz os ativos da org e pontua em memória. A busca por token (palavra
    // difusa, número exato) não é exprimível num `ilike` — e é ela que impede o
    // 128GB de aparecer para quem pediu 256GB. O corte por org acontece no
    // banco, que é o que importa para o isolamento.
    //
    // ⚠️ O TETO PEDIDO NÃO ERA O TETO APLICADO. `supabase/config.toml:12`
    // declara `max_rows = 1000`: o PostgREST corta a resposta nesse número, e o
    // `.limit(2000)` que estava aqui nunca trouxe 2000 — trouxe no máximo 1000.
    // Por isso a truncagem NÃO pode ser deduzida de `linhas.length === limite`:
    // o corte é do servidor e o cliente não sabe qual é. Quem sabe é o `count`,
    // que a consulta passa a pedir — varredura parcial vira DADO, não palpite.
    //
    // E sem `ORDER BY` o Postgres devolve linhas ARBITRÁRIAS: a ordem é a que o
    // plano der, e muda com o tempo e com o vacuum. Numa loja acima do teto, o
    // produto pedido podia não estar no lote que veio, e a busca respondia "não
    // há nada com esse nome" para um produto que a loja TEM. (issue #480)
    // ⚠️ `count` é `number | null`, e o `null` NÃO significa zero: significa que
    // o servidor não disse quantos há (cabeçalho `Content-Range` ausente ou não
    // parseável — proxy, gateway, versão). A versão anterior fazia
    // `total = count ?? total` com `total` iniciado em 0, e a parada
    // `linhas.length >= total` virava `>= 0` — verdadeira já na primeira página.
    // Resultado: varria 1 página de uma loja de 3000, não achava, e ainda dizia
    // "não há nada com esse nome" com `varreduraParcial` FALSO, porque
    // `0 > 1000` é falso. O defeito da issue #480 voltava inteiro e em silêncio.
    //
    // Agora quem prova o fim é uma PÁGINA VAZIA, que é fato independente do
    // count: não há linha depois de `de`. O count, quando vem, só antecipa a
    // parada. E `varreduraParcial` passa a ser "não cheguei ao fim", em vez de
    // uma comparação com um total que pode nunca ter existido.
    const linhas: unknown[] = [];
    let total: number | null = null;
    let alcancouOFim = false;
    for (let pagina = 0; pagina < PAGINAS_MAXIMAS; pagina++) {
      const de = pagina * TAMANHO_DA_PAGINA;
      const { data: lote, error, count } = await ctx.supabase
        .from("catalog_products")
        .select(
          "id, codigo, nome, descricao, marca, categoria, preco_cents, moeda, controla_estoque, quantidade, ativo, destaque, preco_promocional_cents, promocao_ate",
          { count: "exact" },
        )
        .eq("organization_id", ctx.organizationId)
        .eq("ativo", true)
        // Ordem estável e única: o corte, quando houver, é reproduzível — e a
        // paginação por `range` só é correta sobre uma ordem determinística.
        .order("codigo", { ascending: true })
        .range(de, de + TAMANHO_DA_PAGINA - 1);

      if (error) throw new Error(`buscar_produtos_falhou: ${error.message}`);
      if (count !== null) total = count;
      const recebidas = lote ?? [];
      linhas.push(...recebidas);
      // Página vazia = não há mais nada. Vale mesmo sem count.
      if (recebidas.length === 0) {
        alcancouOFim = true;
        break;
      }
      // Com count, dá para parar sem gastar a ida que confirmaria o vazio —
      // que é o caso da esmagadora maioria das lojas, pequenas e numa página só.
      if (total !== null && linhas.length >= total) {
        alcancouOFim = true;
        break;
      }
    }

    const data = linhas;
    // A varredura foi parcial? Isso é o que separa "não achei no que varri" de
    // "a loja não tem" — e só a segunda pode ser dita ao cliente.
    const varreduraParcial = !alcancouOFim;

    type Linha = {
      id: string;
      codigo: string;
      nome: string;
      descricao: string | null;
      marca: string | null;
      categoria: string | null;
      preco_cents: number;
      moeda: string;
      controla_estoque: boolean;
      quantidade: number;
      destaque: boolean | null;
      preco_promocional_cents: number | null;
      promocao_ate: string | null;
    };

    const { achados, ignorados } = buscarComRelaxamento((data ?? []) as Linha[], input.termo);

    // `controla_estoque` é o conserto de uma armadilha da versão anterior, que
    // filtrava por quantidade sempre: numa loja que não conta estoque (decant de
    // perfume, item sob encomenda) o catálogo INTEIRO ficava invisível.
    const disponiveis = input.somente_disponiveis
      ? achados.filter((a) => !a.produto.controla_estoque || a.produto.quantidade > 0)
      : achados;

    const topo = disponiveis.slice(0, input.limite);

    if (topo.length === 0) {
      if (achados.length > 0) {
        return {
          produtos: [],
          mensagem:
            "esse produto existe no catálogo, mas está sem estoque. Não prometa: ofereça avisar quando chegar.",
        };
      }
      // Afirmar ausência exige ter varrido o catálogo inteiro. Sobre uma
      // amostra, a frase honesta é outra — e ela leva o agente a uma conduta
      // diferente com o cliente, que é o ponto.
      return {
        produtos: [],
        mensagem: varreduraParcial
          ? `não encontrei entre os ${linhas.length} produtos que consegui consultar, e o catálogo ` +
            `desta loja tem ${total}. NÃO diga que a loja não tem — diga que vai confirmar com a ` +
            "equipe. Se a pessoa souber o código ou o nome exato, peça: com ele a busca acha."
          : "não há nada com esse nome no catálogo da loja. Não invente preço — diga que vai confirmar com a equipe.",
      };
    }

    // Empate é o sinal de que a pessoa precisa escolher. Ex.: "iphone 15 pro 256"
    // casa o Pro e o Pro Max igualmente, e a diferença entre eles é o preço.
    const empate = topo.length > 1 && topo[0]!.nota === topo[1]!.nota;

    const mensagem = avisosDaBusca({ empate, ignorados });

    return {
      produtos: topo.map(({ produto }) => {
        // Mesmo preço de vitrine da tela: promoção válida vence o base — uma
        // regra só, ou o agente anuncia um preço e o pedido cobra outro.
        const vitrine = precoDeVitrine(
          {
            preco_cents: produto.preco_cents,
            preco_promocional_cents: produto.preco_promocional_cents,
            promocao_ate: produto.promocao_ate,
          },
          new Date().toISOString().slice(0, 10),
        );
        return {
          codigo: produto.codigo,
          nome: produto.nome,
          preco: precoLegivel(vitrine.cents, produto.moeda),
          preco_cents: vitrine.cents,
          ...(vitrine.emPromocao ? { em_promocao: true as const } : {}),
          ...(produto.marca ? { marca: produto.marca } : {}),
          ...(produto.descricao ? { descricao: produto.descricao } : {}),
          disponivel: !produto.controla_estoque || produto.quantidade > 0,
        };
      }),
      empate,
      // Relaxamento é o irmão do empate: nos dois a busca sabe que a resposta
      // NÃO é exatamente o que foi pedido, e nos dois quem decide é a pessoa.
      // A diferença é o que falta — no empate, qual das opções; aqui, se o
      // número que sumiu importava.
      ...(ignorados.length > 0 ? { numeros_ignorados: ignorados } : {}),
      ...(mensagem ? { mensagem } : {}),
    };
  },
};

// ---------------------------------------------------------------------------
// montar rascunho de pedido (ATT.txt F4 — a IA vende de verdade)
// ---------------------------------------------------------------------------

const montarPedidoShape = {
  contact_id: z.string().uuid().optional().describe("o cliente, quando você sabe quem é na conversa"),
  cliente_nome: z.string().trim().min(2).max(200).describe("nome do cliente para o cabeçalho do pedido"),
  itens: z
    .array(
      z.object({
        codigo: z.string().trim().min(1).max(60).describe("o CÓDIGO do produto, como voltou em `crm_search_products` — nunca o nome"),
        quantidade: z.number().int().min(1).max(1000),
      }),
    )
    .min(1)
    .max(20),
  observacoes: z.string().trim().max(2000).optional(),
};

export const commercialCreateOrder: McpToolDefinition<typeof montarPedidoShape> = {
  name: "commercial_create_order",
  description:
    "Monta o RASCUNHO de um pedido comercial a partir do que o cliente pediu na conversa. " +
    "Use quando o cliente confirmou os itens e as quantidades: a ferramenta cria o pedido como " +
    "RASCUNHO (origem ia) e devolve o número e o total para você mostrar e pedir a confirmação final. " +
    "RASCUNHO NÃO É VENDA: estoque não baixa de verdade para rascunho, e um humano aprova depois — " +
    "diga isso ao cliente ('deixei o pedido montado, o vendedor confirma já já'). " +
    "Passe CÓDIGOS vindos de `crm_search_products`, nunca nomes lembrados: código que não existe " +
    "é recusado e a recusa nomeia qual. Preço sai do catálogo, não do seu input — você não informa preço. " +
    "Se o cliente ainda está comparando opções, NÃO monte pedido: apresente os produtos primeiro.",
  inputSchema: montarPedidoShape,
  category: "write",
  // Piso `ai_operator`, não `agent`: criar pedido muda a casa (estoque
  // reservado, crédito consumido) e não é trabalho de atendente. `ai_operator`
  // vive só no token efêmero — nenhuma pessoa o alcança — e é o papel do
  // agente publicado, então a IA continua alcançando deliberadamente.
  requiresRole: "ai_operator",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    // Resolve códigos → produtos (match exato no código da org). Nome não
    // resolve: nome é ambíguo e preço errado é promessa.
    const codigos = [...new Set(input.itens.map((i) => i.codigo))];
    const { data: prods, error } = await ctx.supabase
      .from("catalog_products")
      .select("id, codigo, preco_cents")
      .eq("organization_id", ctx.organizationId)
      .eq("ativo", true)
      .in("codigo", codigos);
    if (error) throw new Error(`montar_pedido_falhou: ${error.message}`);
    const porCodigo = new Map(((prods ?? []) as { id: string; codigo: string; preco_cents: number }[]).map((p) => [p.codigo, p]));
    const faltando = codigos.find((c) => !porCodigo.has(c));
    if (faltando) {
      return {
        rascunho: false,
        motivo: "codigo_desconhecido",
        mensagem: `não há produto com código "${faltando}" no catálogo. Confira com \`crm_search_products\` e tente de novo — não chute outro código.`,
      };
    }

    const resultado = await criarPedidoComercial(ctx.supabase, ctx.supabase, {
      orgId: ctx.organizationId,
      userId: null,
      // IA nunca ignora trava comercial: sem estoque ou sem crédito, o
      // rascunho volta recusado e você explica ao cliente.
      podeIgnorar: false,
    }, {
      contact_id: input.contact_id ?? null,
      cliente_nome: input.cliente_nome,
      status: "rascunho",
      origem: "ia",
      moeda: "BRL",
      desconto_cents: 0,
      frete_cents: 0,
      modalidade_frete: "retirada",
      ignorar_estoque: false,
      ignorar_credito: false,
      ...(input.observacoes ? { observacoes: input.observacoes } : {}),
      itens: input.itens.map((i) => {
        const p = porCodigo.get(i.codigo);
        return {
          product_id: p ? p.id : null,
          quantidade: i.quantidade,
          preco_unit_cents: p ? p.preco_cents : 0,
          desconto_pct: 0,
        };
      }),
    });

    if (!resultado.ok) {
      return {
        rascunho: false,
        motivo: resultado.code,
        mensagem: resultado.message + " Explique ao cliente com suas palavras e ofereça alternativa.",
      };
    }

    const pedido = resultado.pedido as { numero: number; total_cents: number; id: string };
    const total = (pedido.total_cents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 });
    return {
      rascunho: true,
      numero: `PED-${String(pedido.numero).padStart(4, "0")}`,
      total: `R$ ${total}`,
      itens: resultado.itens,
      mensagem:
        "Rascunho montado — mostre número e total ao cliente e peça a confirmação. " +
        "Avise que um vendedor confere e aprova em seguida.",
    };
  },
};
