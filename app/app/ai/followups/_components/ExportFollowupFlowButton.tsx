"use client";

import { useT } from "@/hooks/i18n/useT";

import { Button } from "@/components/ui/button";
import { DownloadSimple } from "@/lib/ui/icons";
import { useExportFollowupFlow } from "@/hooks/followup/useFollowupFlows";

type Props = {
  flowId: string;
  variant?: "outline" | "ghost";
  size?: "sm" | "default";
};

/** Baixa o fluxo como `.fluxo.json` — o arquivo que «Importar fluxo» aceita, nesta ou em outra conta. */
export function ExportFollowupFlowButton({ flowId, variant = "outline", size = "sm" }: Props) {
  const t = useT();
  const exportar = useExportFollowupFlow();

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      disabled={exportar.isPending}
      data-testid="export-followup-flow"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        exportar.mutate(flowId);
      }}
    >
      <DownloadSimple size={14} aria-hidden className="mr-1" />
      {exportar.isPending ? t("Exportando…") : t("Exportar")}
    </Button>
  );
}
