"use client";

import { useT } from "@/hooks/i18n/useT";
import { cn } from "@/lib/utils";

/**
 * Estado de carregamento inline: spinner + rótulo para leitores de tela.
 * Respeita `prefers-reduced-motion` (o spinner congela via CSS global).
 */
export function NexusLoading({ label, className }: { label?: string; className?: string }) {
  const t = useT();
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "flex items-center justify-center gap-3 py-10 text-sm text-muted-foreground",
        className,
      )}
    >
      <span
        aria-hidden
        className="nexus-spinner inline-block h-5 w-5 rounded-full border-2 border-border border-t-accent"
      />
      <span>{label ?? t("Carregando…")}</span>
    </div>
  );
}
