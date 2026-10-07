"use client";

import type { NodeProps } from "@xyflow/react";

import type { RFNode } from "@/lib/followup/graph-mappers";
import { useT } from "@/hooks/i18n/useT";
import { NODE_VISUALS, describeNodeConfig } from "./nodeVisuals";
import { NodeCard } from "./NodeCard";

/**
 * O nó `edit_lead_tag` no canvas (#2065) — "editar lead (tag)", a fatia de
 * edição que entra neste PR. "Informação" e "disparar campanha" ficaram de fora
 * e são o passo seguinte da issue.
 */
export function EditLeadTagNode({ id, data, selected }: NodeProps<RFNode>) {
  const t = useT();
  return (
    <NodeCard
      id={id}
      visual={NODE_VISUALS.edit_lead_tag}
      label={data.label}
      subtitle={describeNodeConfig("edit_lead_tag", data.config, t)}
      selected={selected}
      errors={data.errors}
    />
  );
}
