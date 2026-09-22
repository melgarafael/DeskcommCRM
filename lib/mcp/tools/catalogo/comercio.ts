/**
 * Capacidades de COMÉRCIO e PRIVACIDADE — o que o cliente comprou, o que existe
 * à venda, e quem pediu para sair.
 *
 * Ver `docs/handoffs/BRIEFING-ia-360.md` §4 para o contrato dos campos.
 */
import { declararTools } from "./tipos";

export const TOOLS_COMERCIO = declararTools([
  {
    name: "crm_list_contact_orders",
    category: "read",
    rotulo: "Ver as compras do cliente",
    explicacao:
      "Mostra o que este cliente já comprou, quanto pagou e como está a entrega, para o assistente não prometer prazo no escuro nem repetir uma oferta já aceita.",
    oQueToca: "Compras do cliente",
    risco: "seguro",
    pacotes: ["vender", "atender"],
  },
  {
    name: "crm_search_products",
    category: "read",
    rotulo: "Procurar produto na loja",
    explicacao:
      "Procura um produto no catálogo da loja e devolve o preço exato e o que está disponível, para o assistente responder com o valor cadastrado em vez de estimar.",
    oQueToca: "Catálogo da loja",
    risco: "seguro",
    pacotes: ["vender", "atender"],
  },
  {
    name: "commercial_create_order",
    category: "write",
    rotulo: "Montar rascunho de pedido",
    explicacao:
      "Monta o rascunho do pedido com o que o cliente confirmou na conversa. Sai sempre como RASCUNHO com origem IA: um humano aprova depois. Sem estoque ou sem crédito, volta recusado.",
    oQueToca: "Pedidos da loja (rascunho)",
    // Crítico de propósito: dinheiro em movimento não entra no default de
    // nenhum agente — o dono liga por agente, sabendo o que está ligando.
    risco: "critico",
    pacotes: ["vender"],
  },
  {
    name: "crm_list_privacy_requests",
    category: "read",
    rotulo: "Ver pedidos de privacidade",
    explicacao:
      "Mostra quem pediu para exportar ou apagar os próprios dados e qual o prazo, para o assistente parar de insistir com quem pediu para sair.",
    oQueToca: "Privacidade e dados do cliente",
    risco: "seguro",
    pacotes: ["organizar", "atender"],
  },
]);
