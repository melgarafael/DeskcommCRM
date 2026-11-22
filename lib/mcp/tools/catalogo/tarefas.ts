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
  {
    name: "crm_complete_task",
    category: "write",
    rotulo: "Concluir ou reabrir uma tarefa",
    explicacao:
      "Fecha uma tarefa como feita, ou devolve para pendente se o trabalho não terminou, e registra isso na linha do tempo do negócio.",
    oQueToca: "Tarefas da equipe",
    risco: "atencao",
    pacotes: ["escalar"],
  },
  {
    name: "crm_delete_task",
    category: "write",
    rotulo: "Apagar uma tarefa",
    explicacao:
      "Remove a tarefa de vez, sem deixar registro de que ela existiu — não dá para desfazer. Para encerrar o trabalho, prefira concluir.",
    oQueToca: "Tarefas da equipe",
    risco: "critico",
    pacotes: ["escalar"],
  },
]);
