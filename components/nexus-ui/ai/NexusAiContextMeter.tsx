import { cn } from "@/lib/utils";

/**
 * Medidor de consumo (custo, tokens, invocações) contra um teto conhecido
 * (membro nativo do DS). Sem teto, não há medidor — número solto vira texto,
 * não barra. `used` e `limit` na MESMA unidade (a legenda diz qual).
 */
export function NexusAiContextMeter({
  label,
  used,
  limit,
  format,
  className,
}: {
  label: string;
  used: number;
  limit: number;
  format: (v: number) => string;
  className?: string;
}) {
  if (limit <= 0) return null;
  const pct = Math.min(100, Math.max(0, (used / limit) * 100));
  const quente = pct >= 80;
  return (
    <div className={cn("rounded-lg border border-border bg-surface p-3", className)}>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="font-medium text-text">{label}</span>
        <span className="text-muted-foreground tabular-nums">
          {format(used)} / {format(limit)}
        </span>
      </div>
      <div
        className="mt-2 h-2 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <div
          className={cn("h-full rounded-full", quente ? "bg-warning" : "bg-accent")}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
