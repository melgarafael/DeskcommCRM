"use client";

import type { NodeProps } from "@xyflow/react";

import type { RFNode } from "@/lib/followup/graph-mappers";
import { nodeBranches } from "@/lib/followup/graph-schema";
import { useT } from "@/hooks/i18n/useT";
import type { ConfigOf } from "../forms/shared";
import { NODE_VISUALS, describeNodeConfig } from "./nodeVisuals";
import { NodeCard } from "./NodeCard";

export function ClassifyNode({ id, data, selected }: NodeProps<RFNode>) {
  const t = useT();
  return (
    <NodeCard
      id={id}
      visual={NODE_VISUALS.ai_classify}
      label={data.label}
      subtitle={describeNodeConfig("ai_classify", data.config, t)}
      selected={selected}
      errors={data.errors}
      branches={nodeBranches({ type: "ai_classify", config: data.config as ConfigOf<"ai_classify"> })}
    />
  );
}
