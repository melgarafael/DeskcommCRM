/**
 * Capacidades de TAREFA (#4516) — a rotina que a equipe combinou consigo mesma.
 *
 * ESTE ARQUIVO FALA COM O HUMANO que configura o agente. O texto que vai ao
 * MODELO é a `description` do handler (`lib/mcp/tools/tarefas.ts`), e ela NÃO
 * tem cópia aqui — duplicata que ninguém lê não é documentação, é armadilha.
 *
 * ⚠️ "TAREFA" É A PALAVRA CERTA e não tem sinônimo melhor: a pessoa que usa o
 * produto diz "criei uma tarefa para a Ana ligar de volta". O gate
 * `tests/unit/catalogo-tools-leigo-friendly.test.ts` reprova jargão e rótulo
 * com sublinhado; as palavras de wire ficam só no `name`, que é contrato.
 *
 * ⚠️ APAGAR É `critico` E ISSO NÃO É EXAGERO. A régua do repo é "efeito que não
 * dá para desfazer": concluir se desfaz (reabre), apagar não. Consequência
 * deliberada — crítico nunca entra por pacote, então a IA só apaga se o dono
 * ligar a capacidade explicitamente. Falha fechado no lado certo.
 */
import { declararTools } from "./tipos";

export const TOOLS_TAREFAS = declararTools([
  {
    name: "crm_list_tasks",
    category: "read",
    rotulo: "Consultar as tarefas da equipe",
    explicacao:
      "Mostra as tarefas em aberto com prazo, prioridade e responsável, para saber o que está combinado e o que está atrasado.",
    oQueToca: "Tarefas da equipe",
    risco: "seguro",
    pacotes: ["organizar"],
  },
  {
    name: "crm_create_task",
    category: "write",
    rotulo: "Criar uma tarefa para a equipe",
    explicacao:
      "Cria uma tarefa com prazo e responsável, presa ou não a um negócio, para ninguém esquecer o que foi combinado na conversa.",
    oQueToca: "Tarefas da equipe",
    // `atencao` e não `critico`: tarefa criada a mais se apaga; o custo é a
    // equipe ver um item a mais na lista, não perder dado.
    risco: "atencao",
    pacotes: ["organizar"],
  },
  {
    name: "crm_update_task",
    category: "write",
    rotulo: "Editar uma tarefa",
    explicacao:
      "Muda o prazo, a prioridade ou o responsável de uma tarefa existente, mantendo o que já estava combinado.",
    oQueToca: "Tarefas da equipe",
    // `atencao`: o gate de catálogo não deixa escrita anunciada como consulta —
    // e ele está certo. Mudar prazo ou responsável errado desorganiza a rotina
    // de alguém; o efeito se desfaz, então não é `critico`.
    risco: "atencao",
    pacotes: ["organizar"],
  },
  {
    name: "crm_complete_task",
    category: "write",
    rotulo: "Concluir ou reabrir uma tarefa",
    explicacao:
      "Fecha uma tarefa como feita, ou devolve para pendente se o trabalho não terminou, e registra isso na linha do tempo do negócio.",
    oQueToca: "Tarefas da equipe",
    // `atencao`: fechar enganado se reabre, mas o registro na linha do tempo do
    // negócio não é apagado — o efeito se desfaz, a história fica.
    risco: "atencao",
    pacotes: ["organizar"],
  },
  {
    name: "crm_delete_task",
    category: "write",
    rotulo: "Apagar uma tarefa",
    explicacao:
      "Remove a tarefa de vez, sem deixar registro de que ela existiu — não dá para desfazer. Para encerrar o trabalho, prefira concluir.",
    oQueToca: "Tarefas da equipe",
    risco: "critico",
    pacotes: ["organizar"],
  },
]);
