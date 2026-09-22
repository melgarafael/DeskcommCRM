"use client";

import { ShieldX, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { cn } from "@/lib/utils";

/**
 * Estado de erro padronizado para tabelas, painéis e páginas. Sempre oferece
 * ação (tentar de novo ou voltar); nunca tela branca, nunca erro mudo.
 */
export function NexusErrorState({
  title,
  description,
  onRetry,
  retryLabel,
  variant = "error",
  className,
}: {
  title?: string;
  description?: string;
  onRetry?: () => void;
  retryLabel?: string;
  variant?: "error" | "denied";
  className?: string;
}) {
  const t = useT();
  const Icon = variant === "denied" ? ShieldX : TriangleAlert;
  const titulo = title ?? t("Algo deu errado");
  const descricao = description ?? t("Não foi possível carregar estes dados. Tente novamente.");
  const tentar = retryLabel ?? t("Tentar novamente");
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center justify-center rounded-lg border border-border bg-surface px-6 py-12 text-center",
        className,
      )}
    >
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-error-bg text-error">
        <Icon size={24} aria-hidden />
      </div>
      <h3 className="text-base font-semibold text-text">{titulo}</h3>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">{descricao}</p>
      {onRetry ? (
        <Button type="button" variant="outline" onClick={onRetry} className="mt-4">
          {tentar}
        </Button>
      ) : null}
    </div>
  );
}
