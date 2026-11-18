import { declararTools } from "./tipos";

export const TOOLS_TAREFAS = declararTools([
  {
    name: "crm_create_task",
    category: "write",
    rotulo: "Criar tarefa da equipe",
    explicacao:
      "Agenda uma tarefa ou retorno vinculado a um cliente, atendimento ou negócio com prazo e responsável.",
    oQueToca: "Tarefas da equipe",
    risco: "atencao",
    pacotes: ["escalar"],
  },
  {
    name: "crm_list_tasks",
    category: "read",
    rotulo: "Listar tarefas da equipe",
    explicacao:
      "Consulta a lista de tarefas pendentes e agendamentos internos com filtros de prazo e setor.",
    oQueToca: "Tarefas da equipe",
    risco: "seguro",
    pacotes: ["escalar"],
  },
  {
    name: "crm_update_task",
    category: "write",
    rotulo: "Atualizar tarefa da equipe",
    explicacao:
      "Altera o status (ex: concluída), prazo, prioridade, responsável ou detalhes de uma tarefa.",
    oQueToca: "Tarefas da equipe",
    risco: "atencao",
    pacotes: ["escalar"],
  },
]);
