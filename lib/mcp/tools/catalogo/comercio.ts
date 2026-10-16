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
    name: "crm_send_catalog_product",
    category: "write",
    rotulo: "Enviar produto do catálogo",
    explicacao:
      "Envia o card oficial do produto do catálogo (com foto, preço e botão interativo) direto na conversa do cliente no WhatsApp.",
    oQueToca: "Mensagens e catálogo da loja",
    risco: "seguro",
    pacotes: ["vender", "atender"],
  },
  {
    name: "crm_draft_proposal",
    category: "write",
    rotulo: "Rascunhar proposta comercial",
    explicacao:
      "Cria um rascunho de proposta a partir do que foi combinado na conversa — uma pessoa sempre revisa e envia depois, e pode editar antes de despachar.",
    oQueToca: "Propostas comerciais",
    risco: "atencao",
    pacotes: ["vender"],
    capacidade: "propostas",
  },
  {
    name: "crm_preparar_proposta",
    category: "read",
    rotulo: "Preparar a proposta com o cliente",
    explicacao:
      "Mostra os modelos de proposta da empresa, diz o que perguntar ao cliente antes de rascunhar e lista os campos que o modelo escolhido pede, para a proposta nascer completa.",
    oQueToca: "Propostas comerciais",
    risco: "seguro",
    pacotes: ["vender"],
    capacidade: "propostas",
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
  {
    name: "crm_consultar_estoque_bling",
    category: "read",
    rotulo: "Consultar estoque no Bling ERP",
    explicacao:
      "Consulta o saldo físico e disponível de produtos diretamente no Bling ERP pelo nome ou código SKU, para o assistente responder com precisão o que está disponível sem prometer itens esgotados.",
    oQueToca: "Estoque no Bling ERP",
    risco: "seguro",
    pacotes: ["vender", "atender"],
  },
]);
