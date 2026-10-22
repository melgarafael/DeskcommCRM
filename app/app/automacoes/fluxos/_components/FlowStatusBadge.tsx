import { Badge } from "@/components/ui/badge";
import { useT } from "@/hooks/i18n/useT";
import type { FollowupFlowStatus } from "@/hooks/followup/useFollowupFlows";

const LABEL: Record<FollowupFlowStatus, string> = {
  draft: "Rascunho",
  active: "Ativo",
  disabled: "Desativado",
};

const VARIANT: Record<FollowupFlowStatus, "neutral" | "success" | "warning"> = {
  draft: "neutral",
  active: "success",
  disabled: "warning",
};

export function FlowStatusBadge({ status }: { status: FollowupFlowStatus }) {
  const t = useT();
  return (
    <Badge variant={VARIANT[status]} aria-label={`${t("status")}: ${t(LABEL[status])}`}>
      {t(LABEL[status])}
    </Badge>
  );
}
