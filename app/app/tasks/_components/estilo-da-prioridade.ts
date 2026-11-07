/**
 * A APARÊNCIA DA PRIORIDADE, num lugar só.
 *
 * A lista e o quadro mostram o mesmo selo para a mesma prioridade. Duas cópias
 * da tabela de cores divergem na primeira mudança — e a divergência aqui seria
 * muda: a mesma tarefa "urgente" sairia vermelha numa visão e cinza na outra.
 *
 * A cor é do TEMA, nunca um hex: ela tem de sobreviver ao claro e ao escuro.
 */
import type { PrioridadeDaTarefa } from "@/lib/tarefas/tipos";

export const COR_DA_PRIORIDADE: Record<PrioridadeDaTarefa, string> = {
  low: "bg-muted text-muted-foreground",
  medium: "bg-primary/10 text-primary",
  high: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  urgent: "bg-destructive/15 text-destructive",
};

/**
 * O ponto colorido do cabeçalho de cada coluna do quadro. Não é a cor da
 * prioridade: é a da SITUAÇÃO, e serve para reconhecer a coluna de relance.
 */
export const COR_DA_SITUACAO: Record<string, string> = {
  pending: "bg-muted-foreground/40",
  in_progress: "bg-primary",
  done: "bg-emerald-500",
  cancelled: "bg-destructive/60",
  sem_situacao: "bg-amber-500/70",
};
