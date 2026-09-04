"use client";
import type { MouseEvent } from "react";

import { useT } from "@/hooks/i18n/useT";
import { cn } from "@/lib/utils";
import { useDecidirReativacao } from "@/hooks/kanban/useReativacao";

interface ReactivationSlotProps {
  leadId: string;
  /** A identidade da proposta na tela — a trava do servidor compara com ela. */
  proposalId: string;
  pipelineId: string;
  /** Quando o prazo acaba. O card diz quanto falta, não a data. */
  expiresAt: string;
}

/** "em 3h", "em 2 dias" — quanto RESTA, que é o que decide se a pessoa age agora. */
function quantoFalta(
  iso: string,
  t: (texto: string) => string,
  agora = Date.now(),
): string {
  const ms = new Date(iso).getTime() - agora;
  if (ms <= 0) return t("vencendo");
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.max(1, Math.round(ms / 60_000))}min`;
  if (h < 24) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

/**
 * A faixa ③ quando o negócio esfriou e o sistema propôs retomar.
 *
 * ⚠️ O PRAZO APARECE NO CARD, e essa é a diferença visível em relação à próxima
 * ação da wave 4. Uma proposta com prazo que não mostra o prazo é a mesma
 * simulação de atenção que o prazo existe para evitar: quem olha precisa saber
 * que a janela fecha, senão "decido depois" é indistinguível de "decidi não".
 *
 * O rótulo diz RETOMAR, não "reativar": o usuário não pensa em estado de
 * sistema, pensa em falar com a pessoa de novo.
 */
export function ReactivationSlot({
  leadId,
  proposalId,
  pipelineId,
  expiresAt,
}: ReactivationSlotProps) {
  const t = useT();
  const decidir = useDecidirReativacao(pipelineId);

  const decide = (e: MouseEvent<HTMLButtonElement>, decision: "accept" | "dismiss") => {
    // O card inteiro seleciona ao clique; decidir não é selecionar.
    e.stopPropagation();
    decidir.mutate({ leadId, decision, proposalId });
  };

  const resta = quantoFalta(expiresAt, t);

  return (
    <>
      <span
        className="min-w-0 flex-1 truncate text-warning-fg"
        title={t("Este negócio parou de responder")}
      >
        {t("Retomar contato?")}{" "}
        <span className="text-text-muted" title={`${t("A sugestão vence em")} ${resta}`}>
          · {resta}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          disabled={decidir.isPending}
          onClick={(e) => decide(e, "accept")}
          aria-label={t("Retomar contato com este negócio")}
          className={cn(
            "rounded-md px-1.5 py-0.5 text-[11px] font-medium transition-colors",
            "bg-warning-fg/10 text-warning-fg hover:bg-warning-fg/20",
            "disabled:opacity-50",
          )}
        >
          {t("Retomar")}
        </button>
        <button
          type="button"
          disabled={decidir.isPending}
          onClick={(e) => decide(e, "dismiss")}
          // "Encerrar" e não "Ignorar": ignorar não é decisão, e a recusa AQUI é
          // decisão registrada — o que distingue negócio encerrado com critério
          // de negócio esquecido.
          aria-label={t("Encerrar: não retomar este negócio")}
          className={cn(
            "rounded-md px-1.5 py-0.5 text-[11px] transition-colors",
            "text-text-muted hover:bg-surface-muted hover:text-text",
            "disabled:opacity-50",
          )}
        >
          {t("Encerrar")}
        </button>
      </span>
    </>
  );
}
