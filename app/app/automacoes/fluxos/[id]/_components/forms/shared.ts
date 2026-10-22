import type { FlowNode } from "@/lib/followup/graph-schema";

/** Config do nó daquele `type` — o mesmo estreitamento que o painel usa para escolher o formulário. */
export type ConfigOf<T extends FlowNode["type"]> = Extract<FlowNode, { type: T }>["config"];

export function msToMin(ms: number): number {
  return Math.round(ms / 60_000);
}

export function minToMs(min: number): number {
  return Math.round(min * 60_000);
}
