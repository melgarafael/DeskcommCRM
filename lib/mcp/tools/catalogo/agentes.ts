/**
 * EDITAR OS ASSISTENTES DE IA — capacidades de quem administra a empresa,
 * pensadas para um aplicativo externo como o ChatGPT: ver como cada assistente
 * está instruído, ver o que ele fez numa conversa, corrigir num RASCUNHO,
 * testar, publicar e voltar atrás.
 *
 * Todas são `apenasHumano` e pedem papel de administrador: um assistente nunca
 * reescreve as próprias instruções (o papel dele no turno é `ai_operator`,
 * abaixo de admin — é o papel que impede, a marca só declara). Publicar e
 * reverter são `critico`: mudam o que os clientes recebem a partir da próxima
 * mensagem, e o cliente externo deve pedir confirmação antes de cada chamada.
 *
 * As regras moram em `lib/ai/agents/edicao.ts` e `lib/ai/agents/teste-da-versao.ts`
 * — as mesmas da tela do assistente.
 */
import { declararTools } from "./tipos";

export const TOOLS_AGENTES = declararTools([
  {
    name: "crm_list_ai_agents",
    category: "read",
    rotulo: "Ver os assistentes e suas versões",
    explicacao:
      "Lista os assistentes de IA da empresa com o número que cada um atende, a versão que está valendo e se há um rascunho em preparo.",
    oQueToca: "Assistentes de IA",
    risco: "seguro",
    pacotes: ["evoluir"],
    apenasHumano: true,
  },
  {
    name: "crm_get_ai_agent_version",
    category: "read",
    rotulo: "Ler as instruções de um assistente",
    explicacao:
      "Mostra o texto de instruções e as configurações de uma versão do assistente — a que está valendo, o rascunho ou uma versão antiga.",
    oQueToca: "Assistentes de IA",
    risco: "seguro",
    pacotes: ["evoluir"],
    apenasHumano: true,
  },
  {
    name: "crm_get_ai_agent_turn",
    category: "read",
    rotulo: "Ver por que o assistente respondeu assim",
    explicacao:
      "Mostra, numa conversa, as últimas respostas do assistente junto com a versão das instruções que ele usou, o que consultou e se alguma regra barrou o envio.",
    oQueToca: "Conversas e assistentes de IA",
    risco: "seguro",
    pacotes: ["evoluir"],
    apenasHumano: true,
  },
  {
    name: "crm_save_ai_agent_draft",
    category: "write",
    rotulo: "Corrigir as instruções num rascunho",
    explicacao:
      "Grava uma correção nas instruções de um ou mais assistentes como RASCUNHO. O que os clientes recebem não muda até alguém publicar.",
    oQueToca: "Rascunho do assistente de IA",
    risco: "atencao",
    pacotes: ["evoluir"],
    apenasHumano: true,
  },
  {
    name: "crm_test_ai_agent_version",
    category: "write",
    rotulo: "Testar um rascunho com uma mensagem",
    explicacao:
      "Simula uma mensagem de cliente e mostra o que o assistente responderia com aquela versão. Nada é enviado a ninguém; o teste consome créditos do modelo de IA.",
    oQueToca: "Teste do assistente de IA",
    risco: "atencao",
    pacotes: ["evoluir"],
    apenasHumano: true,
  },
  {
    name: "crm_publish_ai_agent_version",
    category: "write",
    rotulo: "Publicar uma versão do assistente",
    explicacao:
      "Coloca uma versão para valer: a partir da próxima mensagem, os clientes passam a ser atendidos com essas instruções. A anterior fica no histórico.",
    oQueToca: "Atendimento dos clientes",
    risco: "critico",
    pacotes: ["evoluir"],
    apenasHumano: true,
  },
  {
    name: "crm_rollback_ai_agent",
    category: "write",
    rotulo: "Voltar o assistente a uma versão anterior",
    explicacao:
      "Copia uma versão antiga do histórico e a coloca para valer de novo, desfazendo uma publicação que piorou o atendimento.",
    oQueToca: "Atendimento dos clientes",
    risco: "critico",
    pacotes: ["evoluir"],
    apenasHumano: true,
  },
]);
