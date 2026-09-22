"use client";

import { Check } from "lucide-react";
import { useT } from "@/hooks/i18n/useT";
import { cn } from "@/lib/utils";

/**
 * Indicador de passos (fluxo guiado). Só permite voltar a passos já
 * alcançados — nunca pular validação para frente pelo indicador.
 */
export function NexusSteps({
  steps,
  current,
  reached,
  onGo,
}: {
  steps: string[];
  current: number;
  reached: number;
  onGo: (index: number) => void;
}) {
  const t = useT();
  return (
    <ol aria-label={t("Etapas")} className="flex items-center gap-1 sm:gap-2">
      {steps.map((label, i) => {
        const done = i < current || (i < reached && i !== current);
        const active = i === current;
        const clickable = i <= reached;
        return (
          <li key={label} className="flex min-w-0 flex-1 items-center gap-1 sm:gap-2">
            <button
              type="button"
              disabled={!clickable}
              onClick={() => onGo(i)}
              aria-current={active ? "step" : undefined}
              className={cn(
                "nexus-transition flex min-h-[44px] min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left",
                active && "bg-accent-soft",
                clickable && !active && "hover:bg-surface-elevated",
                !clickable && "cursor-not-allowed opacity-50",
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
                  active && "bg-accent text-accent-foreground",
                  done && !active && "bg-success-bg text-success-fg",
                  !active && !done && "bg-surface-elevated text-muted-foreground",
                )}
              >
                {done && !active ? <Check size={14} /> : i + 1}
              </span>
              <span
                className={cn(
                  "truncate text-xs font-medium sm:text-sm",
                  active ? "text-text" : "text-muted-foreground",
                )}
              >
                {label}
              </span>
            </button>
            {i < steps.length - 1 ? (
              <span aria-hidden className="h-px w-2 shrink-0 bg-border sm:w-4" />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
