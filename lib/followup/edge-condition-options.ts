import type { FlowEdge, FlowNode } from "./graph-schema";

/**
 * Per-source-node menu of valid edge conditions for the builder's edge
 * config panel (Task 6.3). Mirrors exactly what `validate-publish.ts` accepts
 * for each source type — an `ai_classify` node needs one `class_match` edge
 * per declared class + `no_reply` + an `always` fallback; a `condition` node
 * routes `cond_result` true/false; everything else only ever takes `always`.
 */
export type EdgeConditionOption = {
  /** Stable key for a <Select> — encodes the condition so option <-> value round-trips exactly. */
  key: string;
  /** pt-br label shown to the user. */
  label: string;
  condition: FlowEdge["condition"];
};

const ALWAYS_OPTION: EdgeConditionOption = { key: "always", label: "Sempre", condition: { type: "always" } };

function classMatchOption(value: string): EdgeConditionOption {
  return {
    key: `class_match:${value}`,
    label: value === "no_reply" ? "Sem resposta" : value,
    condition: { type: "class_match", value },
  };
}

function condResultOption(value: boolean): EdgeConditionOption {
  return {
    key: `cond_result:${value}`,
    label: value ? "Sim" : "Não",
    condition: { type: "cond_result", value },
  };
}

export function edgeConditionOptions(sourceNode: FlowNode | undefined): EdgeConditionOption[] {
  if (sourceNode?.type === "ai_classify") {
    return [
      ALWAYS_OPTION,
      ...sourceNode.config.classes.map(classMatchOption),
      classMatchOption("no_reply"),
    ];
  }
  if (sourceNode?.type === "condition") {
    return [ALWAYS_OPTION, condResultOption(true), condResultOption(false)];
  }
  return [ALWAYS_OPTION];
}

/** Stable key for a condition value — inverse of the `key` on the option it produced. */
export function conditionKey(condition: FlowEdge["condition"]): string {
  switch (condition.type) {
    case "always":
      return "always";
    case "class_match":
      return `class_match:${condition.value}`;
    case "cond_result":
      return `cond_result:${condition.value}`;
  }
}

/** Human label for a condition value, used both by the options above and the edge's on-wire label. */
export function conditionLabel(condition: FlowEdge["condition"]): string {
  switch (condition.type) {
    case "always":
      return "Sempre";
    case "class_match":
      return condition.value === "no_reply" ? "Sem resposta" : condition.value;
    case "cond_result":
      return condition.value ? "Sim" : "Não";
  }
}
