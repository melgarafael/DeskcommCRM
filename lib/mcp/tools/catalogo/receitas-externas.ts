/**
 * Capacidade do BANCO DE DADOS EXTERNO: consultar receitas prontas (Spec 25 R1).
 *
 * `modulo: "banco_externo"`: com o módulo desligado em `/admin/sistema`, esta
 * entrada some da tela de capacidades, do agente publicado e do cliente MCP
 * externo. Ver `deModuloDesligado` em `./index.ts`.
 */
import { declararTools } from "./tipos";

export const TOOLS_RECEITAS_EXTERNAS = declararTools([
  {
    name: "crm_consultar_receita",
    category: "read",
    rotulo: "Consultar receitas prontas do banco conectado",
    explicacao:
      "Lista as receitas prontas da conexão (ex.: produtos do WooCommerce) e executa uma delas com filtros, para o assistente responder ao cliente com o dado real do banco de origem — só leitura.",
    oQueToca: "Banco de dados conectado",
    risco: "seguro",
    pacotes: ["organizar"],
    modulo: "banco_externo",
  },
  {
    name: "crm_registrar_interesse_no_item",
    category: "write",
    rotulo: "Registrar interesse num item do banco conectado",
    // No pacote "organizar", como a irmã `crm_consultar_receita`: "vender" é o pacote padrão do
    // onboarding e uma ferramenta a mais ali estoura o teto por agente (pacote-reserva-vaga-da-critica).
    explicacao:
      "Quando o cliente demonstra interesse num item que o assistente achou no banco conectado (um imóvel, um produto), abre a oportunidade no funil escolhido para aquela receita, com a referência do item. Sem funil escolhido, só avisa a equipe na Central.",
    oQueToca: "Funil de vendas e Central de avisos",
    risco: "atencao",
    pacotes: ["organizar"],
    modulo: "banco_externo",
  },
]);
