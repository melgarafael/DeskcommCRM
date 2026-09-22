"use client";

import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { cn } from "@/lib/utils";

export interface NexusInsight {
  id: string;
  text: string;
  /** Ação contextual opcional (ex.: "Ver clientes", "Abrir pedido"). */
  actionLabel?: string;
  onAction?: () => void;
}

/**
 * Bloco de resumo inteligente (dashboard / customer 360 / radar). Componente
 * nativo do Design System: recebe dados REAIS via props. Sem insights, mostra
 * estado neutro — nunca inventa número.
 */
export function NexusAiBriefing({
  title,
  insights,
  emptyText,
  className,
}: {
  title?: string;
  insights: NexusInsight[];
  emptyText?: string;
  className?: string;
}) {
  const t = useT();
  const titulo = title ?? t("Resumo inteligente");
  return (
    <section
      aria-label={titulo}
      className={cn("rounded-lg border border-border bg-surface p-4 shadow-xs", className)}
    >
      <header className="mb-3 flex items-center gap-2">
        <Sparkles size={16} aria-hidden className="text-accent" />
        <h2 className="text-sm font-semibold text-text">{titulo}</h2>
      </header>
      {insights.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {emptyText ?? t("Sem novidades por enquanto. Volte mais tarde.")}
        </p>
      ) : (
        <ul className="space-y-3">
          {insights.map((insight) => (
            <li key={insight.id} className="flex items-start justify-between gap-3 text-sm">
              <p className="text-text">{insight.text}</p>
              {insight.actionLabel && insight.onAction ? (
                <Button variant="ghost" size="sm" onClick={insight.onAction} className="shrink-0">
                  {insight.actionLabel}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Sugestão de IA inline (ex.: resposta de WhatsApp, mensagem de campanha).
 * Sempre com aprovar/descartar explícitos — nunca envia sozinha.
 */
export function NexusAiSuggestion({
  text,
  sourceLabel,
  onApprove,
  onDismiss,
  approveLabel,
  dismissLabel,
  className,
}: {
  text: string;
  sourceLabel?: string;
  onApprove?: () => void;
  onDismiss?: () => void;
  approveLabel?: string;
  dismissLabel?: string;
  className?: string;
}) {
  const t = useT();
  return (
    <div className={cn("rounded-lg border border-accent-200 bg-accent-50 p-3 text-sm", className)}>
      <p className="flex items-center gap-1.5 text-xs font-medium text-accent-700">
        <Sparkles size={12} aria-hidden />
        {t("Sugestão da IA")}
        {sourceLabel ? <span className="font-normal">· {sourceLabel}</span> : null}
      </p>
      <p className="mt-1.5 text-text">{text}</p>
      {onApprove || onDismiss ? (
        <div className="mt-2.5 flex gap-2">
          {onDismiss ? (
            <Button variant="ghost" size="sm" onClick={onDismiss}>
              {dismissLabel ?? t("Descartar")}
            </Button>
          ) : null}
          {onApprove ? (
            <Button variant="primary" size="sm" onClick={onApprove}>
              {approveLabel ?? t("Usar sugestão")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
