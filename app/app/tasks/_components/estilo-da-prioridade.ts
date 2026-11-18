/**
 * A APARÊNCIA DA PRIORIDADE, num lugar só.
 *
 * A lista e o quadro mostram o mesmo selo para a mesma prioridade. Duas cópias
 * da tabela de cores divergem na primeira mudança — e a divergência aqui seria
 * muda: a mesma tarefa "urgente" sairia vermelha numa visão e cinza na outra.
 *
 * A cor é do TEMA, nunca um hex: ela tem de sobreviver ao claro e ao escuro.
 */
import type { PrioridadeDaTarefa, UrgenciaDoPrazo } from "@/lib/tarefas/tipos";

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

/**
 * O FAROL PREVENTIVO DE PRAZOS (#SPEC-KANBAN-FISCAL):
 * Destaques visuais para os cartões de tarefa conforme as faixas de SLA.
 */
export const ESTILO_DA_URGENCIA: Record<
  UrgenciaDoPrazo,
  {
    bordaCartao: string;
    fundoCartao: string;
    badge: string;
    textoPrazo: string;
    icone: string;
  }
> = {
  normal: {
    bordaCartao: "border-border",
    fundoCartao: "bg-card",
    badge: "bg-muted text-muted-foreground",
    textoPrazo: "text-muted-foreground",
    icone: "",
  },
  atencao_48h: {
    bordaCartao: "border-yellow-500/50 dark:border-yellow-600/50",
    fundoCartao: "bg-yellow-500/[0.03] dark:bg-yellow-950/20",
    badge: "bg-yellow-500/15 text-yellow-800 dark:text-yellow-300 font-medium",
    textoPrazo: "text-yellow-800 dark:text-yellow-300 font-medium",
    icone: "⏳",
  },
  vence_hoje: {
    bordaCartao: "border-amber-500/70 dark:border-amber-500/60",
    fundoCartao: "bg-amber-500/[0.05] dark:bg-amber-950/25",
    badge: "bg-amber-500/20 text-amber-800 dark:text-amber-200 font-semibold",
    textoPrazo: "text-amber-800 dark:text-amber-300 font-semibold",
    icone: "⏰",
  },
  atrasada: {
    bordaCartao: "border-destructive/70 dark:border-destructive/60",
    fundoCartao: "bg-destructive/[0.05] dark:bg-destructive/10",
    badge: "bg-destructive/20 text-destructive font-semibold",
    textoPrazo: "text-destructive font-semibold",
    icone: "⚠️",
  },
};
