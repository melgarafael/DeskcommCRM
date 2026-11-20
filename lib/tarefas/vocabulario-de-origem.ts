/**
 * De onde uma `crm_tasks` nasceu — vocabulário ABERTO (sem CHECK no banco,
 * CLAUDE.md doutrina de Migrations). `null`/ausente = criada à mão.
 */
export type TaskSourceKind = "promised_proposal" | "promised_followup";

export const TASK_SOURCE_LABELS: Record<TaskSourceKind, string> = {
  promised_proposal: "Promessa de proposta detectada pelo assistente",
  promised_followup: "Compromisso detectado pelo assistente",
};

/**
 * A `origem` que `criarTarefaInterna` grava na auditoria e no ator da linha do tempo
 * quando a tarefa nasce do adiamento na prospecção ("agora não, me chama mês que vem",
 * `lib/prospecting/resposta-da-prospeccao.ts`). Constante: quem grava e quem procura
 * usam a mesma.
 */
export const ORIGEM_ADIAMENTO_DA_PROSPECCAO = "prospeccao:adiamento" as const;
