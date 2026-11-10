/**
 * Capacidades de EVOLUCAO — o que a empresa ja sabe e o que o agente aprende.
 *
 * ESTE ARQUIVO FALA COM O HUMANO que configura o agente — `rotulo`,
 * `explicacao` e `oQueToca`. O texto que vai ao MODELO é a `description` do
 * HANDLER (`lib/mcp/tools/<dominio>.ts`), e ela NÃO tem cópia aqui: até
 * 2026-08-07 tinha, ninguém lia essa cópia, e 48 das 51 divergiam do que o
 * modelo realmente recebia. O campo foi removido em vez de sincronizado —
 * duplicata que ninguém lê não é documentação, é armadilha: um script de
 * medição de vazamento chegou a montar o prompt com o texto errado, sob um
 * comentário dizendo "a ferramenta como o modelo a vê".
 * Ver `docs/handoffs/BRIEFING-ia-360.md` §4.
 *
 * DECISAO DELIBERADA — a IA nao aprova a propria melhoria. As propostas do
 * flywheel (`flywheel_distiller_proposals`) sao expostas para LEITURA. Nenhuma
 * capacidade de aprovar entra neste catalogo: o gate humano e o desenho do
 * flywheel, e dar ao agente o poder de aprovar mudancas em si mesmo removeria
 * exatamente a trava que torna a auto-melhoria segura. Aprovar continua sendo
 * um clique de pessoa, na tela do agente.
 */
import { declararTools } from "./tipos";

export const TOOLS_EVOLUCAO = declararTools([
  {
    name: "crm_search_knowledge",
    category: "read",
    rotulo: "Consultar o que a empresa já sabe",
    explicacao:
      "Procura a resposta nos materiais que você cadastrou, para o assistente responder com a informação da sua empresa em vez de inventar.",
    oQueToca: "Base de conhecimento",
    risco: "seguro",
    pacotes: ["evoluir", "atender"],
  },
  {
    name: "crm_list_knowledge_sources",
    category: "read",
    rotulo: "Ver os materiais cadastrados",
    explicacao:
      "Mostra quais materiais estão no acervo da empresa e se foram processados, para saber se faltou conteúdo ou se algo falhou.",
    oQueToca: "Base de conhecimento",
    risco: "seguro",
    pacotes: ["evoluir"],
  },
  {
    name: "crm_list_improvement_proposals",
    category: "read",
    rotulo: "Ver sugestões de melhoria",
    explicacao:
      "Mostra as melhorias que o sistema sugeriu a partir dos atendimentos, com o motivo de cada uma. Aprovar continua sendo decisão sua.",
    oQueToca: "Aprendizado do assistente",
    risco: "seguro",
    pacotes: ["evoluir"],
  },
  {
    name: "crm_get_org_memory",
    category: "read",
    rotulo: "Consultar as regras da empresa",
    explicacao:
      "Lê as políticas e combinados que valem para todo atendimento, para o assistente seguir a regra da casa em vez de inventar uma. Anotação vencida não volta — o assistente não repete a programação da semana passada.",
    oQueToca: "Regras da empresa",
    risco: "seguro",
    pacotes: ["evoluir", "atender"],
  },
  {
    name: "crm_save_org_memory",
    category: "write",
    rotulo: "Anotar uma regra aprendida",
    explicacao:
      "Guarda um aprendizado que vale para todos os atendimentos, marcado como escrito pelo assistente para você distinguir do que anotou. Pode ter prazo: a anotação com data de validade deixa de ser lida sozinha depois dela.",
    oQueToca: "Regras da empresa",
    risco: "atencao",
    pacotes: ["evoluir"],
  },
]);
