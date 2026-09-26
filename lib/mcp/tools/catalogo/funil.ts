/**
 * Capacidades de FUNIL — oportunidades de venda e as etapas por onde passam.
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
 */
import { declararTools } from "./tipos";

export const TOOLS_FUNIL = declararTools([
  {
    name: "crm_list_leads",
    category: "read",
    rotulo: "Listar oportunidades do funil",
    explicacao:
      "Lista as oportunidades de venda de um funil, com a etapa em que cada uma está e quem é o responsável por ela.",
    oQueToca: "Funil de vendas",
    risco: "seguro",
    pacotes: ["vender"],
  },
  {
    name: "crm_get_lead",
    category: "read",
    rotulo: "Ver uma oportunidade",
    explicacao:
      "Abre os detalhes de uma oportunidade de venda: etapa atual, responsável, marcadores e valor do negócio.",
    oQueToca: "Funil de vendas",
    risco: "seguro",
    pacotes: ["vender"],
  },
  {
    name: "crm_list_pipelines",
    category: "read",
    rotulo: "Listar funis",
    explicacao:
      "Mostra os funis de venda existentes e suas etapas, para o agente saber onde pode colocar uma oportunidade.",
    oQueToca: "Funil de vendas",
    risco: "seguro",
    pacotes: ["vender", "organizar"],
  },
  {
    name: "crm_create_lead",
    category: "write",
    rotulo: "Criar oportunidade no funil",
    explicacao:
      "Registra uma nova oportunidade de venda no funil, para que o interesse demonstrado pelo cliente não se perca.",
    oQueToca: "Funil de vendas",
    risco: "atencao",
    pacotes: ["vender"],
  },
  {
    name: "crm_update_lead",
    category: "write",
    rotulo: "Atualizar uma oportunidade",
    explicacao:
      "Altera dados de uma oportunidade de venda: valor do negócio, responsável e informações colhidas na conversa.",
    oQueToca: "Funil de vendas",
    risco: "atencao",
    pacotes: ["vender"],
  },
  {
    name: "crm_move_lead_stage",
    category: "write",
    rotulo: "Mover oportunidade de etapa",
    explicacao:
      "Move a oportunidade para outra etapa do funil, registrando o avanço da negociação ou a perda do negócio.",
    oQueToca: "Funil de vendas",
    risco: "atencao",
    pacotes: ["vender"],
  },
  {
    name: "crm_retomar_lead",
    category: "write",
    rotulo: "Retomar negócio encerrado como novo",
    explicacao:
      "Abre uma nova tentativa para um negócio perdido ou ganho, no mesmo funil e com o mesmo contato, sem alterar o negócio original.",
    oQueToca: "Funil de vendas",
    risco: "atencao",
    // "reter", como `crm_propose_reactivation`: é o cliente que voltou depois
    // de uma perda. Em "vender" ela entraria no agente que nasce no onboarding
    // e estouraria o teto dos outros pacotes (pacote-reserva-vaga-da-critica).
    pacotes: ["reter"],
  },
]);
