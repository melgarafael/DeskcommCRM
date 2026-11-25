"use client";

import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";

export function ErroDoPainel({
  mensagem,
  tentando,
  onRetry,
}: {
  mensagem: string;
  tentando: boolean;
  onRetry: () => void;
}) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <p role="alert" className="text-sm text-destructive">{mensagem}</p>
      <Button variant="outline" size="sm" disabled={tentando} onClick={onRetry}>
        {t("Tentar de novo")}
      </Button>
    </div>
  );
}
