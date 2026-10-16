"use client";

import { useT } from "@/hooks/i18n/useT";
import type { ResumoDasTarefas } from "@/lib/tarefas/tipos";
import { ListChecks, Warning } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

/**
 * O selo de tarefas do card: quantas estão em aberto e, se houver, quantas já
 * venceram — o que o card diz sem abrir o dossiê.
 *
 * Mora na faixa do dono (④), que já tem altura fixa: o card tem orçamento de
 * altura e não cresce com dado novo (ver o cabeçalho do `KanbanCard`). Some por
 * inteiro sem tarefa em aberto — a rota do quadro nem manda o campo.
 *
 * Vermelho só quando há atraso: é o único estado que pede ação agora, e cor em
 * todo card com tarefa viraria ruído (Lei C do card — cor só quando o estado
 * pede).
 */
export function TarefasNoCard({ tarefas }: { tarefas?: ResumoDasTarefas }) {
  const t = useT();
  if (!tarefas || tarefas.abertas === 0) return null;

  const descricao =
    `${tarefas.abertas} ${tarefas.abertas === 1 ? t("tarefa aberta") : t("tarefas abertas")}` +
    (tarefas.atrasadas > 0
      ? ` · ${tarefas.atrasadas} ${tarefas.atrasadas === 1 ? t("atrasada") : t("atrasadas")}`
      : "");

  return (
    <span
      role="img"
      aria-label={descricao}
      title={descricao}
      className={cn(
        "flex shrink-0 items-center gap-0.5 text-[11px] tabular-nums",
        tarefas.atrasadas > 0 ? "font-semibold text-destructive" : "text-text-muted",
      )}
    >
      <ListChecks size={12} aria-hidden />
      {tarefas.abertas}
      {tarefas.atrasadas > 0 ? (
        <>
          <Warning size={12} aria-hidden className="ml-1" />
          {tarefas.atrasadas}
        </>
      ) : null}
    </span>
  );
}
