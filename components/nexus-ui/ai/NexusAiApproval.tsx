"use client";

import { Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { cn } from "@/lib/utils";

/**
 * Aprovação explícita de ação sugerida pela IA (membro nativo do DS).
 * Nunca executa sozinha: aprovar e dispensar são gestos humanos distintos,
 * ambos registrados. `busy` trava os dois durante a mutação.
 */
export function NexusAiApproval({
  title,
  description,
  context,
  approveLabel,
  dismissLabel,
  approveAria,
  dismissAria,
  busy = false,
  enabled = true,
  onApprove,
  onDismiss,
  className,
}: {
  title: string;
  description?: string;
  context?: React.ReactNode;
  approveLabel?: string;
  dismissLabel?: string;
  approveAria?: string;
  dismissAria?: string;
  busy?: boolean;
  enabled?: boolean;
  onApprove: () => void;
  onDismiss: () => void;
  className?: string;
}) {
  const t = useT();
  return (
    <div className={cn("rounded-lg border border-border bg-surface p-4", className)}>
      <p className="text-sm font-medium text-text">{title}</p>
      {description ? <p className="mt-1 text-sm text-foreground/90">{description}</p> : null}
      {context ? <div className="mt-1 text-xs text-muted-foreground">{context}</div> : null}
      <div className="mt-3 flex gap-2">
        <Button size="sm" disabled={!enabled || busy} onClick={onApprove} aria-label={approveAria}>
          <Check size={14} aria-hidden />
          {busy ? t("Decidindo…") : (approveLabel ?? t("Aprovar"))}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!enabled || busy}
          onClick={onDismiss}
          aria-label={dismissAria}
        >
          <X size={14} aria-hidden />
          {dismissLabel ?? t("Dispensar")}
        </Button>
      </div>
    </div>
  );
}
