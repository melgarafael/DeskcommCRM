"use client";

import { useT } from "@/hooks/i18n/useT";

import { Button } from "@/components/ui/button";
import { Copy } from "@/lib/ui/icons";
import { useDuplicateFollowupFlow } from "@/hooks/followup/useFollowupFlows";

type Props = {
  flowId: string;
  variant?: "outline" | "ghost";
  size?: "sm" | "default";
};

export function DuplicateFollowupFlowButton({ flowId, variant = "outline", size = "sm" }: Props) {
  const t = useT();
  const duplicate = useDuplicateFollowupFlow();

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      disabled={duplicate.isPending}
      data-testid="duplicate-followup-flow"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        duplicate.mutate(flowId);
      }}
    >
      <Copy size={14} aria-hidden className="mr-1" />
      {duplicate.isPending ? t("Duplicando…") : t("Duplicar")}
    </Button>
  );
}
