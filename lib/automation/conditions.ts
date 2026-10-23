import { z } from "zod";

/**
 * Condições do motor de regras: filtros de campo combinados por grupos `all`
 * (todas) / `any` (qualquer uma).
 *
 * ─── Compatibilidade (leia antes de mudar o avaliador) ─────────────────────
 *
 * O formato guardado em `automation_rules.conditions` (jsonb) SEMPRE foi um
 * array simples de `{ field, op, value }`, combinado por E. Ele CONTINUA
 * válido: o array é lido como `all` — a mesma semântica de antes desta
 * mudança, regra por regra. Só a forma nova, que a tela passa a gravar, é que
 * pode ser também um grupo `{"all":[...]}` ou `{"any":[...]}` do TOPO — o que
 * a API aceita hoje (ver `conditionsSchema`); aninhar grupo em grupo é do
 * AVALIADOR, não da porta.
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

/**
 * Os operadores que NÃO pedem valor: "está vazio" e "está preenchido" perguntam
 * pelo campo, não por um texto (#2727). Uma fonte só: a tela esconde o campo de
 * valor, o formulário não o exige, o desenho não o descarta e o avaliador o
 * ignora. Enquanto cada lugar tinha a sua lista, o `desenho-da-regra` filtrava
 * por `value.trim()` e ENGOLIA a condição `is_empty` — a regra voltava sem
 * condição nenhuma e passava a disparar para todo mundo.
 */
export const OPERADORES_SEM_VALOR: ReadonlySet<ConditionOp> = new Set<ConditionOp>([
  "is_empty",
  "is_not_empty",
]);

/**
 * O teto de condições de UMA regra (#2727). Vale no TOPO: a lista simples e os
 * filhos do grupo do topo. Antes desta fatia o teto era `10` no array; o schema
 * aninhável tinha `50` por nível, o que AMPLIAVA o limite de qualquer regra.
 */
export const MAXIMO_DE_CONDICOES = 10;

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

/** Um nó é uma CONDIÇÃO de campo (tem `field`), não um grupo. */
export function ehCondicaoDeCampo(no: ConditionNode): no is RuleCondition {
  return typeof no === "object" && no !== null && "field" in no;
}

/**
 * Quantas CONDIÇÕES de campo a regra tem, somando o grupo do topo. O que a tela
 * de operação mostra como "N condições" antes de alguém ligar a regra — e o que
 * contava `0` quando o guardado era `{any:[…]}` (um objeto não tem `.length`).
 */
export function contarCondicoes(conditions: Conditions): number {
  const soma = (nos: readonly ConditionNode[]): number =>
    nos.reduce((total, no) => total + (ehGrupo(no) ? soma(no.all ?? no.any ?? []) : 1), 0);
  if (Array.isArray(conditions)) return soma(conditions);
  // Vem de jsonb: pode ser `null`/`undefined`/qualquer coisa. Contar 0 é a
  // resposta honesta — estourar aqui derrubaria a tela de operação inteira.
  const grupo = conditions as ConditionGroup | null | undefined;
  return soma(grupo?.all ?? grupo?.any ?? []);
}

/** Vazio = ausente, string vazia/branca ou lista vazia. `0` e `false` NÃO são vazios. */
function ehVazio(valor: unknown): boolean {
  if (valor === undefined || valor === null) return true;
  if (typeof valor === "string") return valor.trim() === "";
  if (Array.isArray(valor)) return valor.length === 0;
  return false;
}

/**
 * A forma sobre a qual `contains` compara — nos DOIS lados (#2973): minúsculas,
 * sem acento, e a pontuação trocada por espaço.
 *
 * Comparar sem caixa já era o comportamento. Sem acento não era, e a regra que
 * não casa não dá erro nem aviso: o operador lê a automação como aleatória.
 * Quem escreve a regra digita "anúncio" e o lead manda "anuncio" (ou o
 * contrário); "Olá" só casava "Olá", nunca "Ola" nem "olá!".
 *
 * `NFD` separa a letra do sinal e a faixa `\u0300-\u036f` (Marcas Diacríticas
 * Combinantes) tira só o acento. NÃO use `\p{M}` às cegas: ele comeria o
 * `U+FE0F` (variation selector) que fecha emoji como o coração, e a regra
 * deixaria de casar o que o próprio cadastro tem — armadilha já medida em
 * `lib/contacts/busca-regex.ts`.
 *
 * A pontuação vira ESPAÇO (`\p{P}`), e os espaços se juntam — decisão do dono
 * do produto (16/10, doc 161, opção D). Assim "Olá! Vi o anúncio" casa "ola, vi
 * o anuncio" (o lead edita a mensagem pronta do anúncio) e "pré-venda" casa
 * "pre venda". Apagar a pontuação de vez juntaria o que é diferente: "10,00"
 * viraria "1000" e casaria "1.000"; "@gmail.com" casaria "gmailcom".
 */
export function normalizarParaContains(valor: unknown): string {
  return String(valor)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\p{P}+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A forma de comparar de uma regra. Regra que a normalização esvazia (feita só
 * de pontuação, como "?") compara como antes do #2973 — só sem caixa: com o
 * alvo vazio, "contém" casaria TODA mensagem, e uma regra que manda WhatsApp
 * passaria a disparar para todo mundo depois de uma atualização.
 */
function formaDaRegra(valorDaRegra: string): (valor: unknown) => string {
  return normalizarParaContains(valorDaRegra) === ""
    ? (valor) => String(valor).toLowerCase()
    : normalizarParaContains;
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
 * inteira — decisão do dono do produto (16/09): "Google" pega `google` e NÃO
 * pega `google ads`, porque uma atualização não pode fazer uma regra que
 * dispara WhatsApp alcançar quem ela não alcançava. Em TEXTO segue sendo
 * "contém" de verdade (o campo `event.event_type_name` usa isso para
 * "Manutenção" pegar os três tipos de atendimento).
 *
 * A FORMA de comparar é UMA só e vem de `formaDaRegra` (#2973): os DOIS ramos
 * passam por ela. O texto já ignorava caixa; a lista continua PERTINÊNCIA — o
 * que a normalização acerta aqui é só a GRAFIA da tag ("tráfego" acha
 * `trafego`), nunca o pedaço dela. Antes cada ramo repetia a sua
 * (`toLowerCase` aqui, `toLowerCase` ali) e ninguém tinha escrito a regra do
 * acento em lugar nenhum.
 */
function contem(raw: unknown, alvo: string): boolean {
  const forma = formaDaRegra(alvo);
  const needle = forma(alvo);
  if (Array.isArray(raw)) return raw.some((item) => forma(item) === needle);
  return forma(raw).includes(needle);
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

/**
 * O grupo do TOPO — e só ele (#2727, escopo desta fatia).
 *
 * Os filhos são CONDIÇÕES de campo, nunca outro grupo: a API REST de hoje ainda
 * aceitava aninhamento e nenhuma tela o desenha (`RuleEditor` carrega com
 * `listaDoTopo.filter(ehLinha)` e salva só as linhas, então `{all:[A,{any:[B,C]}]}`
 * aberto e salvo no formulário voltava como `[A]` — a regra perdia o `any`). Até
 * existir tela que o edite, o aninhamento não entra: o que não se edita não se
 * grava. O AVALIADOR (`avaliaNo`) continua entendendo aninhamento, de propósito:
 * ele é leitura defensiva de jsonb que já esteja gravado no banco.
 *
 * O `any: z.undefined().optional()` do outro ramo mantém o combinador ÚNICO: um
 * objeto com as duas chaves não passa por nenhum dos dois.
 */
const conditionGroupSchema: z.ZodType<ConditionGroup> = z.union([
  z.object({
    all: z.array(conditionSchema).max(MAXIMO_DE_CONDICOES),
    any: z.undefined().optional(),
  }),
  z.object({
    any: z.array(conditionSchema).max(MAXIMO_DE_CONDICOES),
    all: z.undefined().optional(),
  }),
]);

/**
 * O que a API aceita em `conditions`: a lista antiga (≡ `all`) ou o grupo do
 * topo. O teto de `MAXIMO_DE_CONDICOES` mora no TOPO, nos dois formatos.
 */
export const conditionsSchema: z.ZodType<Conditions> = z.union([
  z.array(conditionSchema).max(MAXIMO_DE_CONDICOES),
  conditionGroupSchema,
]);
