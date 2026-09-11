/**
 * Capacidades do BANCO DE DADOS EXTERNO (Fase 5).
 *
 * O agente enxerga o outro sistema do dono — o segundo CRM, o ERP, a base que
 * outro produto escreve. Sem isto, o conector seria só uma tela de configuração.
 *
 * Os nomes vivem no `crm_*` porque são contrato de wire: renomear quebraria
 * agentes publicação em VPS de cliente. A camada de apresentação fala a língua
 * de quem configura, não a de quem programa (ver `tests/unit/catalogo-tools-leigo-friendly.test.ts`).
 */
import { declararTools } from "./tipos";

export const TOOLS_DADOS_EXTERNOS = declararTools([
  {
    name: "crm_describe_external_data",
    category: "read",
    rotulo: "Ver as tabelas do banco conectado",
    explicacao:
      "Mostra quais tabelas e campos existem no banco de dados que você conectou, para o assistente saber onde procurar o dado antes de responder.",
    oQueToca: "Banco de dados conectado",
    risco: "seguro",
    pacotes: ["atender", "organizar"],
  },
  {
    name: "crm_query_external_data",
    category: "read",
    rotulo: "Buscar dados no banco conectado",
    explicacao:
      "Lê o conteúdo de uma tabela do banco que você conectou, com filtros, para o assistente responder ao cliente com o dado real em vez de estimar.",
    oQueToca: "Banco de dados conectado",
    risco: "seguro",
    pacotes: ["vender", "atender", "reter"],
  },
]);
