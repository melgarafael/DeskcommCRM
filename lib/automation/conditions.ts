import { z } from "zod";

/**
 * Condições do motor de regras: filtros de campo combinados por grupos `all`
 * (todas) / `any` (qualquer uma), aninháveis.
 *
 * ─── Compatibilidade (leia antes de mudar o avaliador) ─────────────────────
 *
 * O formato guardado em `automation_rules.conditions` (jsonb) SEMPRE foi um
 * array simples de `{ field, op, value }`, combinado por E. Ele CONTINUA
 * válido: o array é lido como `all` — a mesma semântica de antes desta
 * mudança, regra por regra. Só a forma nova, que a tela passa a gravar, é que
 * pode ser também um grupo `{"all":[...]}` ou `{"any":[...]}` (aninháveis).
 * `lib/automation/conditions.test.ts` cobre a regressão: um array antigo avalia
 * IGUAL ao que avaliava antes.
 *
 * ─── Campo AUSENTE: a regra, explícita ─────────────────────────────────────
 *
 * Campo ausente (`undefined`/`null`) NÃO é "vazio": é desconhecido. A decisão
 * desta fatia (issue #2727):
 *
 *   - `is_empty`     → VERDADEIRO em ausente, em string vazia/branca, em lista
 *                      vazia e em `0`? NÃO: `0` é valor presente, não vazio.
 *   - `is_not_empty` → o espelho exato de `is_empty`.
 *   - `neq`          → FALSO em ausente. Era o defeito medido na issue: "crianças
 *                      ≠ 0" disparava para quem nem preencheu o campo. Comparar
 *                      "diferente de" exige um valor para comparar; quem quer
 *                      "não preenchido" escreve `is_empty`, e quem quer "não é X
 *                      e está preenchido" usa `is_not_empty` + `neq`.
 *   - `eq`/`contains`/`not_contains`/comparadores → FALSO em ausente, sempre.
 *
 * Ou seja: SÓ `is_empty`/`is_not_empty` decidem presença. Todo o resto exige
 * campo presente. É a mesma regra nos dois sentidos (o espelho `is_not_empty`).
 */
export type ConditionOp =
  | "eq"
  | "neq"
  | "contains"
  | "not_contains"
  | "is_empty"
  | "is_not_empty"
  | "gt"
  | "gte"
  | "lt"
  | "lte";

/** A ordem em que os operadores aparecem no seletor da tela. */
export const OPS_DE_CONDICAO = [
  "eq",
  "neq",
  "contains",
  "not_contains",
  "is_empty",
  "is_not_empty",
  "gt",
  "gte",
  "lt",
  "lte",
] as const satisfies readonly ConditionOp[];

export interface RuleCondition {
  field: string;
  op: ConditionOp;
  value: string;
}

/**
 * Um grupo combina os filhos por E (`all`) ou por OU (`any`). Um grupo tem
 * EXATAMENTE uma das duas chaves; o schema abaixo recusa as duas juntas e
 * recusa nenhuma.
 */
export interface ConditionGroup {
  all?: ConditionNode[];
  any?: ConditionNode[];
}

/** Um nó é uma condição de campo ou um grupo (por isso é aninhável). */
export type ConditionNode = RuleCondition | ConditionGroup;

/** O que `automation_rules.conditions` aceita: a lista antiga (≡ `all`) ou um grupo. */
export type Conditions = ConditionNode[] | ConditionGroup;

function ehGrupo(no: ConditionNode): no is ConditionGroup {
  return typeof no === "object" && no !== null && !("field" in no);
}

/** Vazio = ausente, string vazia/branca ou lista vazia. `0` e `false` NÃO são vazios. */
function ehVazio(valor: unknown): boolean {
  if (valor === undefined || valor === null) return true;
  if (typeof valor === "string") return valor.trim() === "";
  if (Array.isArray(valor)) return valor.length === 0;
  return false;
}

export function resolveField(context: Record<string, unknown>, path: string): unknown {
  let cur: unknown = context;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/**
 * `contains` entre um valor de campo e o texto da condição.
 *
 * Um operador, um significado (#956). Em lista ele é PERTINÊNCIA: a tag
 * inteira, sem diferenciar caixa — decisão do dono do produto (16/09): "Google"
 * pega `google` e NÃO pega `google ads`, porque uma atualização não pode fazer
 * uma regra que dispara WhatsApp alcançar quem ela não alcançava. Em TEXTO
 * segue sendo "contém" de verdade (o campo `event.event_type_name` usa isso
 * para "Manutenção" pegar os três tipos de atendimento).
 */
function contem(raw: unknown, alvo: string): boolean {
  const needle = alvo.toLowerCase();
  if (Array.isArray(raw)) return raw.some((item) => String(item).toLowerCase() === needle);
  return String(raw).toLowerCase().includes(needle);
}

/**
 * Comparação de ordem (`gt`/`gte`/`lt`/`lte`). Número compara como número; o
 * resto compara como texto — o que faz a data ISO-8601 (`2026-09-14`) ordenar
 * certo sem precisar de parser de data.
 */
function compara(raw: unknown, alvo: string, op: "gt" | "gte" | "lt" | "lte"): boolean {
  const a = Number(raw);
  const b = Number(alvo);
  const ambosNumeros =
    String(raw).trim() !== "" && alvo.trim() !== "" && Number.isFinite(a) && Number.isFinite(b);
  const cmp = ambosNumeros
    ? a === b
      ? 0
      : a < b
        ? -1
        : 1
    : String(raw) === alvo
      ? 0
      : String(raw) < alvo
        ? -1
        : 1;
  switch (op) {
    case "gt":
      return cmp > 0;
    case "gte":
      return cmp >= 0;
    case "lt":
      return cmp < 0;
    case "lte":
      return cmp <= 0;
  }
}

function matches(cond: RuleCondition, context: Record<string, unknown>): boolean {
  const raw = resolveField(context, cond.field);
  const ausente = raw === undefined || raw === null;

  // Presença primeiro: SÓ estes dois operadores decidem campo ausente.
  if (cond.op === "is_empty") return ehVazio(raw);
  if (cond.op === "is_not_empty") return !ehVazio(raw);

  // Todo o resto exige um valor presente.
  if (ausente) return false;

  switch (cond.op) {
    case "eq":
      return String(raw) === cond.value;
    case "neq":
      return String(raw) !== cond.value;
    case "contains":
      return contem(raw, cond.value);
    case "not_contains":
      return !contem(raw, cond.value);
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      return compara(raw, cond.value, cond.op);
  }
}

function avaliaNo(no: ConditionNode, context: Record<string, unknown>): boolean {
  if (ehGrupo(no)) {
    if (Array.isArray(no.all)) return no.all.every((filho) => avaliaNo(filho, context));
    if (Array.isArray(no.any)) return no.any.some((filho) => avaliaNo(filho, context));
    // Grupo sem chave: nada a exigir.
    return true;
  }
  return matches(no, context);
}

/**
 * Avalia as condições guardadas. A lista simples (formato antigo) vale como
 * `all`; um objeto `{all|any}` combina os filhos, recursivamente.
 */
export function evaluateConditions(
  conditions: Conditions,
  context: Record<string, unknown>,
): boolean {
  if (Array.isArray(conditions)) return conditions.every((no) => avaliaNo(no, context));
  return avaliaNo(conditions, context);
}

// ─── Schema (uma fonte para o avaliador e para a porta da API) ──────────────

export const conditionSchema = z.object({
  field: z.string().min(1).max(200),
  op: z.enum(OPS_DE_CONDICAO),
  value: z.string().max(500),
});

const conditionGroupSchema: z.ZodType<ConditionGroup> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(conditionNodeSchema).max(50), any: z.undefined().optional() }),
    z.object({ any: z.array(conditionNodeSchema).max(50), all: z.undefined().optional() }),
  ]),
);

const conditionNodeSchema: z.ZodType<ConditionNode> = z.lazy(() =>
  z.union([conditionSchema, conditionGroupSchema]),
);

/**
 * O que a API aceita em `conditions`: a lista antiga (≡ `all`) ou um grupo.
 * Aninhável — um nó pode ser outro grupo.
 */
export const conditionsSchema: z.ZodType<Conditions> = z.union([
  z.array(conditionNodeSchema).max(50),
  conditionGroupSchema,
]);
