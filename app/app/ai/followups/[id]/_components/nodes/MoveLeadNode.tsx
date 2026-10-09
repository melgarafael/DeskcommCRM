"use client";

import type { NodeProps } from "@xyflow/react";

import type { FlowNode } from "@/lib/followup/graph-schema";
import type { RFNode } from "@/lib/followup/graph-mappers";
import { useT } from "@/hooks/i18n/useT";
import { rotuloDoMotivoDePerda } from "@/lib/schemas/leads";
import { useEtapasDoFluxo } from "../EtapasDoFluxo";
import { NODE_VISUALS, describeNodeConfig } from "./nodeVisuals";
import { NodeCard } from "./NodeCard";

/**
 * O nó `move_lead` no canvas (#2065) — "mover lead no funil".
 *
 * Mesma forma do `internal_task`: a paleta, o schema, o publish e o motor já a
 * conhecem; sem esta linha o React Flow renderizaria o fallback cinza, sem
 * rótulo e sem subtítulo.
 *
 * Destino em etapa de perda mostra o motivo escolhido — ou o aviso de que ele
 * falta, no padrão dos outros nós ("sem etapa de destino"): sem motivo o
 * publish recusa, e o aviso é no card que quem monta olha sem abrir nada.
 */
export function MoveLeadNode({ id, data, selected }: NodeProps<RFNode>) {
  const t = useT();
  const { etapas } = useEtapasDoFluxo();
  const config = data.config as Extract<FlowNode, { type: "move_lead" }>["config"];
  const etapa = etapas.find((e) => e.stageId === config.stage_id);
  const motivo = (config.lost_reason ?? "").trim();
  const base = describeNodeConfig("move_lead", data.config, t);
  const subtitle =
    etapa?.isPerda === true
      ? motivo
        ? `${base} · ${t(rotuloDoMotivoDePerda(motivo))}`
        : `${base} · ${t("falta o motivo da perda")}`
      : base;
  return (
    <NodeCard
      id={id}
      visual={NODE_VISUALS.move_lead}
      label={data.label}
      subtitle={subtitle}
      selected={selected}
      errors={data.errors}
    />
  );
}
