/**
 * Capacidades de GOVERNANCA — fila, direcionamento, marcadores e a passagem
 * do atendimento automatico para uma pessoa.
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

export const TOOLS_GOVERNANCA = declararTools([
  {
    name: "crm_get_queue_status",
    category: "read",
    rotulo: "Ver a fila de atendimento",
    explicacao:
      "Mostra quantas pessoas estão esperando atendimento agora e há quanto tempo, para priorizar quem espera mais.",
    oQueToca: "Atendimento",
    risco: "seguro",
    pacotes: ["atender", "escalar"],
  },
  {
    name: "crm_assign_conversation",
    category: "write",
    rotulo: "Direcionar conversa para alguém",
    explicacao:
      "Passa a conversa para um atendente, transfere para outra pessoa ou devolve o cliente para a fila de espera.",
    oQueToca: "Atendimento",
    risco: "atencao",
    pacotes: ["escalar", "atender"],
  },
  {
    name: "crm_manage_tags",
    category: "write",
    rotulo: "Aplicar marcadores",
    explicacao:
      "Adiciona ou remove marcadores numa conversa, cliente ou oportunidade, para organizar e filtrar a operação depois.",
    oQueToca: "Organização da operação",
    risco: "atencao",
    pacotes: ["organizar", "atender"],
  },
  {
    name: "crm_request_human_handoff",
    category: "handoff",
    rotulo: "Chamar um consultor responsável",
    explicacao:
      "Interrompe o atendimento automático e chama uma pessoa, entregando um resumo do que já aconteceu na conversa.",
    oQueToca: "Atendimento",
    risco: "atencao",
    pacotes: ["escalar"],
  },
]);
