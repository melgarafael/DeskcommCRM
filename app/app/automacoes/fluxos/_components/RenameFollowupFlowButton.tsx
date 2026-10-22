"use client";

import { useT } from "@/hooks/i18n/useT";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { PencilSimple } from "@/lib/ui/icons";
import { RenameFollowupFlowDialog } from "./RenameFollowupFlowDialog";

type Props = {
  flowId: string;
  flowName: string;
  variant?: "outline" | "ghost";
  size?: "sm" | "default" | "icon";
};

export function RenameFollowupFlowButton({
  flowId,
  flowName,
  variant = "outline",
  size = "sm",
}: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        type="button"
        variant={variant}
        size={size}
        data-testid="rename-followup-flow"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen(true);
        }}
        aria-label={size === "icon" ? t("Renomear") : undefined}
      >
        <PencilSimple size={14} aria-hidden className={size === "icon" ? undefined : "mr-1"} />
        {size === "icon" ? null : t("Renomear")}
      </Button>
      <RenameFollowupFlowDialog
        flowId={flowId}
        flowName={flowName}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}
