"use client";
import type { MouseEvent } from "react";

import { useT } from "@/hooks/i18n/useT";
import { cn } from "@/lib/utils";
import { useDecidirProximaAcao } from "@/hooks/kanban/useNextAction";

interface NextActionSlotProps {
  /** O texto que o agente propôs, já roteado para este negócio. */
  label: string;
  leadId: string;
  /** A identidade da proposta na tela — a trava do servidor compara com ela. */
  approvedSeq: number;
  pipelineId: string;
}

/**
 * A faixa ③ quando o agente propôs alguma coisa: o que ele quer fazer, e a
 * decisão do humano ao lado.
 *
 * Cabe na altura já reservada do slot (`h-6`) — nenhum elemento novo entra no
 * orçamento do card (§5). O texto encolhe (`truncate`) e os botões não: numa
 * coluna estreita é a decisão que precisa continuar clicável, e a proposta
 * inteira já está no `title`.
 */
export function NextActionSlot({
  label,
  leadId,
  approvedSeq,
  pipelineId,
}: NextActionSlotProps) {
  const t = useT();
  const decidir = useDecidirProximaAcao(pipelineId);

  const decide = (e: MouseEvent<HTMLButtonElement>, decision: "approve" | "dismiss") => {
    // O card inteiro seleciona ao clique; decidir não é selecionar.
    e.stopPropagation();
    decidir.mutate({ leadId, decision, approvedSeq });
  };

  return (
    <>
      <span className="min-w-0 flex-1 truncate text-accent" title={label}>
        {t("Propõe:")} {label}
      </span>
      <span className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          disabled={decidir.isPending}
          onClick={(e) => decide(e, "approve")}
          // O rótulo curto cabe no card; o acessível diz DE QUE proposta se
          // trata — "Aprovar" sozinho, lido fora de contexto, não decide nada.
          aria-label={`${t("Aprovar:")} ${label}`}
          className={cn(
            "rounded-md px-1.5 py-0.5 text-[11px] font-medium transition-colors",
            "bg-accent/10 text-accent hover:bg-accent/20",
            "disabled:opacity-50",
          )}
        >
          {t("Aprovar")}
        </button>
        <button
          type="button"
          disabled={decidir.isPending}
          onClick={(e) => decide(e, "dismiss")}
          aria-label={`${t("Ignorar:")} ${label}`}
          className={cn(
            "rounded-md px-1.5 py-0.5 text-[11px] transition-colors",
            "text-text-muted hover:bg-surface-muted hover:text-text",
            "disabled:opacity-50",
          )}
        >
          {t("Ignorar")}
        </button>
      </span>
    </>
  );
}
