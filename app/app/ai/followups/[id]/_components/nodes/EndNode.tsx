"use client";

import type { NodeProps } from "@xyflow/react";

import type { RFNode } from "@/lib/followup/graph-mappers";
import { NODE_VISUALS, describeNodeConfig } from "./nodeVisuals";
import { NodeCard } from "./NodeCard";

export function EndNode({ id, data, selected }: NodeProps<RFNode>) {
  return (
    <NodeCard
      id={id}
      visual={NODE_VISUALS.end}
      label={data.label}
      subtitle={describeNodeConfig("end", data.config)}
      selected={selected}
      errors={data.errors}
      showSource={false}
    />
  );
}
