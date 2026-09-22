"use client";

import { BookOpen } from "lucide-react";
import { useT } from "@/hooks/i18n/useT";
import { cn } from "@/lib/utils";

export interface NexusSource {
  id: string;
  label: string;
  detail?: string;
  href?: string;
}

/**
 * Fontes que sustentam uma resposta ou sugestão da IA (membro nativo do DS).
 * Sem fontes, o bloco some — lista vazia não é "sem fontes", é ausência do bloco.
 */
export function NexusAiSources({
  sources,
  title,
  className,
}: {
  sources: NexusSource[];
  title?: string;
  className?: string;
}) {
  const t = useT();
  if (sources.length === 0) return null;
  const titulo = title ?? t("Fontes");
  return (
    <div className={cn("rounded-lg border border-border bg-surface-elevated p-3", className)}>
      <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <BookOpen size={12} aria-hidden />
        {titulo}
      </p>
      <ul className="mt-1.5 space-y-1">
        {sources.map((s) => (
          <li key={s.id} className="text-xs text-muted-foreground">
            {s.href ? (
              <a href={s.href} className="underline underline-offset-4 hover:text-text">
                {s.label}
              </a>
            ) : (
              <span className="text-text">{s.label}</span>
            )}
            {s.detail ? <span> · {s.detail}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
