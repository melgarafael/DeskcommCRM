"use client";

import type { NodeProps } from "@xyflow/react";

import type { RFNode } from "@/lib/followup/graph-mappers";
import { NODE_VISUALS, describeNodeConfig } from "./nodeVisuals";
import { NodeCard } from "./NodeCard";

export function WaitNode({ id, data, selected }: NodeProps<RFNode>) {
  return (
    <NodeCard
      id={id}
      visual={NODE_VISUALS.wait}
      label={data.label}
      subtitle={describeNodeConfig("wait", data.config)}
      selected={selected}
      errors={data.errors}
    />
  );
}
