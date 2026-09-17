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
    // Um operador, um significado (#956). Em lista ele exigia a tag IDÊNTICA,
    // com caixa, enquanto em texto já era "contém" sem caixa — e a tela chama os
    // dois de "contém". Quem escreve a regra digita "Google" e a tag guardada é
    // `google` (o editor do Inbox grava em minúsculas) ou `google ads`.
    const alvo = cond.value.toLowerCase();
    // Em LISTA o operador é pertinência: a tag inteira, sem diferenciar caixa.
    // Decisão do dono do produto (16/09, issue #956): "Google" pega `google` e
    // NÃO pega `google ads`, porque uma atualização não pode fazer uma regra
    // que dispara WhatsApp alcançar quem ela não alcançava. Em TEXTO segue
    // sendo "contém" de verdade — é o que o campo `event.event_type_name`
    // usa para "Manutenção" pegar os três tipos de atendimento.
    if (Array.isArray(raw)) return raw.some((item) => String(item).toLowerCase() === alvo);
    return String(raw).toLowerCase().includes(alvo);
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
