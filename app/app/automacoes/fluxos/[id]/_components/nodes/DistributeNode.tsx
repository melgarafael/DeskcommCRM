"use client";

import type { NodeProps } from "@xyflow/react";

import type { RFNode } from "@/lib/followup/graph-mappers";
import { nodeBranches } from "@/lib/followup/graph-schema";
import { useT } from "@/hooks/i18n/useT";
import type { ConfigOf } from "../forms/shared";
import { NODE_VISUALS, describeNodeConfig } from "./nodeVisuals";
import { NodeCard } from "./NodeCard";

/** O bloco `distribute` no canvas (Automações, out/2026), com uma alça por saída. */
export function DistributeNode({ id, data, selected }: NodeProps<RFNode>) {
  const t = useT();
  return (
    <NodeCard
      id={id}
      visual={NODE_VISUALS.distribute}
      label={data.label}
      subtitle={describeNodeConfig("distribute", data.config, t)}
      selected={selected}
      errors={data.errors}
      branches={nodeBranches({ type: "distribute", config: data.config as ConfigOf<"distribute"> })}
    />
  );
}
