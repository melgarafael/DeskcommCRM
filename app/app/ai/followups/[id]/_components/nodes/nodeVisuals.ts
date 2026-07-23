import type { ComponentType } from "react";

import { Play, Clock, GitBranch, Brain, PaperPlaneTilt, Flag } from "@/lib/ui/icons";
import type { FlowNode, NodeType } from "@/lib/followup/graph-schema";

/**
 * Visual identity per node type — shared by the palette (Task 6.2 increment 2)
 * and the custom node cards (increment 3). Each type gets a DISTINCT icon +
 * Sage token pairing (never a bare default React Flow box): trigger=accent
 * (start), wait=info (calm/waiting), condition=warning (branch), ai_classify=
 * solid accent (the "smart" step), action=success (send/go), end=error
 * (terminal — reads as "stop", not literally an error).
 */
export interface NodeVisual {
  type: NodeType;
  paletteLabel: string;
  icon: ComponentType<{ size?: number; className?: string; "aria-hidden"?: boolean }>;
  /** Icon chip background + text. */
  chipClassName: string;
  /** Left accent border on the node card. */
  borderClassName: string;
  defaultLabel: string;
  defaultConfig: () => FlowNode["config"];
}

export const NODE_VISUALS: Record<NodeType, NodeVisual> = {
  trigger: {
    type: "trigger",
    paletteLabel: "Gatilho",
    icon: Play,
    chipClassName: "bg-accent-soft text-accent",
    borderClassName: "border-l-accent-500",
    defaultLabel: "Início do fluxo",
    defaultConfig: () => ({}),
  },
  wait: {
    type: "wait",
    paletteLabel: "Aguardar",
    icon: Clock,
    chipClassName: "bg-info-bg text-info-fg",
    borderClassName: "border-l-info",
    defaultLabel: "Aguardar",
    defaultConfig: () => ({ mode: "fixed", duration_ms: 300_000 }),
  },
  condition: {
    type: "condition",
    paletteLabel: "Condição",
    icon: GitBranch,
    chipClassName: "bg-warning-bg text-warning-fg",
    borderClassName: "border-l-warning",
    defaultLabel: "Verificar condição",
    defaultConfig: () => ({
      combinator: "and",
      checks: [{ field: "steps_taken", op: "gte", value: 0 }],
    }),
  },
  ai_classify: {
    type: "ai_classify",
    paletteLabel: "Classificar (IA)",
    icon: Brain,
    chipClassName: "bg-accent text-accent-foreground",
    borderClassName: "border-l-accent-700",
    defaultLabel: "Classificar resposta",
    defaultConfig: () => ({
      classes: ["hot", "cold"],
      grace_timeout_ms: 900_000,
      target: "last_reply",
    }),
  },
  action: {
    type: "action",
    paletteLabel: "Ação",
    icon: PaperPlaneTilt,
    chipClassName: "bg-success-bg text-success-fg",
    borderClassName: "border-l-success",
    defaultLabel: "Enviar mensagem",
    defaultConfig: () => ({ mode: "ai_message", prompt_hint: "Configure esta etapa." }),
  },
  end: {
    type: "end",
    paletteLabel: "Fim",
    icon: Flag,
    chipClassName: "bg-error-bg text-error-fg",
    borderClassName: "border-l-error",
    defaultLabel: "Fim do fluxo",
    defaultConfig: () => ({ outcome: "exhausted" }),
  },
};

export const NODE_VISUAL_LIST = Object.values(NODE_VISUALS);

const OUTCOME_LABEL: Record<string, string> = {
  converted: "Convertido",
  exhausted: "Esgotado",
  custom: "Personalizado",
};

type ConfigOf<T extends NodeType> = Extract<FlowNode, { type: T }>["config"];

/**
 * One-line summary of a node's config — shown as the card subtitle. Takes the
 * RF node's own `type`/`data.config` pair (not a reconstructed `FlowNode`)
 * because the node components only ever see React Flow's generic shape.
 */
export function describeNodeConfig(type: NodeType, config: FlowNode["config"]): string {
  switch (type) {
    case "trigger":
      return "Início do fluxo";
    case "wait": {
      const c = config as ConfigOf<"wait">;
      return c.mode === "fixed"
        ? `${Math.round(c.duration_ms / 60_000)} min`
        : `${Math.round(c.min_ms / 60_000)}–${Math.round(c.max_ms / 60_000)} min (adaptativo)`;
    }
    case "condition": {
      const c = config as ConfigOf<"condition">;
      return `${c.checks.length} condição(ões) · ${c.combinator === "and" ? "E" : "OU"}`;
    }
    case "ai_classify": {
      const c = config as ConfigOf<"ai_classify">;
      return `${c.classes.length} classes · grace ${Math.round(c.grace_timeout_ms / 60_000)}min`;
    }
    case "action": {
      const c = config as ConfigOf<"action">;
      return c.mode === "ai_message" ? c.prompt_hint : "Template fixo";
    }
    case "end": {
      const c = config as ConfigOf<"end">;
      return OUTCOME_LABEL[c.outcome] ?? c.outcome;
    }
    default: {
      const exhaustive: never = type;
      return String(exhaustive);
    }
  }
}
