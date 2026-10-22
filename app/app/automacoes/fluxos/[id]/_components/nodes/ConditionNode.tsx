"use client";

import type { NodeProps } from "@xyflow/react";

import type { RFNode } from "@/lib/followup/graph-mappers";
import { nodeBranches } from "@/lib/followup/graph-schema";
import { useT } from "@/hooks/i18n/useT";
import type { ConfigOf } from "../forms/shared";
import { NODE_VISUALS, describeNodeConfig } from "./nodeVisuals";
import { NodeCard } from "./NodeCard";

export function ConditionNode({ id, data, selected }: NodeProps<RFNode>) {
  const t = useT();
  return (
    <NodeCard
      id={id}
      visual={NODE_VISUALS.condition}
      label={data.label}
      subtitle={describeNodeConfig("condition", data.config, t)}
      selected={selected}
      errors={data.errors}
      branches={nodeBranches({ type: "condition", config: data.config as ConfigOf<"condition"> })}
    />
  );
}
