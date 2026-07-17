/**
 * Condições do motor de regras: filtros simples (eq/neq/contains) em AND.
 * Campo ausente = condição falsa (nunca erro). Coerção via String() dos dois
 * lados — o value vem sempre como string da UI.
 */
export type ConditionOp = "eq" | "neq" | "contains";

export interface RuleCondition {
  field: string;
  op: ConditionOp;
  value: string;
}

export function resolveField(context: Record<string, unknown>, path: string): unknown {
  let cur: unknown = context;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function matches(cond: RuleCondition, context: Record<string, unknown>): boolean {
  const raw = resolveField(context, cond.field);
  if (raw === undefined || raw === null) return cond.op === "neq";
  if (cond.op === "contains") {
    if (Array.isArray(raw)) return raw.map(String).includes(cond.value);
    return String(raw).toLowerCase().includes(cond.value.toLowerCase());
  }
  const equal = String(raw) === cond.value;
  return cond.op === "eq" ? equal : !equal;
}

export function evaluateConditions(
  conditions: RuleCondition[],
  context: Record<string, unknown>,
): boolean {
  return conditions.every((c) => matches(c, context));
}
