import { Badge } from "@/components/ui/badge";
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
  return (
    <Badge variant={VARIANT[status]} aria-label={`status: ${LABEL[status]}`}>
      {LABEL[status]}
    </Badge>
  );
}
