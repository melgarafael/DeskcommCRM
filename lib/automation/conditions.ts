import { z } from "zod";

import type { FatosDoContato } from "@/lib/automation/fatos-do-contato";

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

/* ──────────── as condições do CONTATO: follow-up vivo e horário (#3814) ───── */

/**
 * DUAS CONDIÇÕES QUE PERGUNTAM AO BANCO, NÃO AO EVENTO.
 *
 * "O contato já tem um follow-up vivo?" e "o contato tem horário marcado?"
 * eram impossíveis de escrever numa regra: o payload do evento não sabe isso, e
 * as condições só liam o evento e a linha do contato/negócio. O efeito medido
 * era a ação `start_message_flow` falhando com `live_enrollment_exists` (o
 * índice único `idx_followup_enrollments_one_live` recusando o INSERT) e a
 * falha só aparecendo na Atividade da regra.
 *
 * Com as duas, o mesmo gatilho tem duas regras: uma que INICIA o fluxo (para
 * quem não está em follow-up vivo) e outra que cria a tarefa para a recepção.
 *
 * ─── O valor é um texto, e o formato é este ────────────────────────────────
 *
 * `automation_rules.conditions` é jsonb de `{ field, op, value }` e o desenho da
 * regra viaja essa linha como está (`linhasDeCondicoes` → `corpoDoDesenho`). Um
 * campo novo no objeto (`dias`, `tipo`) seria DESCARTADO por esses dois
 * caminhos — o mesmo defeito que o #2727 pagou com `is_empty`, quando o filtro
 * de valor vazio engolia a condição e a regra disparava para todo mundo. Por
 * isso as opções moram dentro do `value`, num formato que o editor decompõe:
 *
 *   follow-up vivo   → `sim` | `nao`
 *   horário marcado  → `sim` | `nao`, e opcionalmente `|N` (dias) e `|TIPO`:
 *                      `sim`, `sim|7`, `sim|7|Manutenção`, `nao|7`
 *                      (o TIPO é o resto do texto e pode ter `|`)
 *
 * Quem lê e escreve é `lerValorDeHorario`/`montarValorDeHorario`; quem recusa o
 * que não é isso é `validarCondicaoDoContato`, usada pelo schema da API (a
 * porta) e pelo desenho da regra (a tela).
 */
export const CAMPOS_DO_CONTATO = {
  /** `sim`/`nao` — "tem inscrição viva em algum fluxo da organização". */
  followUpVivo: "contato.followup_vivo",
  /** `sim`/`nao` com janela e tipo opcionais — "tem compromisso futuro". */
  horarioMarcado: "contato.horario_marcado",
} as const;

export type CampoDoContato = (typeof CAMPOS_DO_CONTATO)[keyof typeof CAMPOS_DO_CONTATO];

const CAMPOS_DO_CONTATO_VALIDOS: ReadonlySet<string> = new Set(Object.values(CAMPOS_DO_CONTATO));

/** As duas respostas possíveis — as MESMAS palavras na tela e no jsonb. */
export const RESPOSTAS_DE_SIM_NAO = ["sim", "nao"] as const;

export type RespostaDeSimNao = (typeof RESPOSTAS_DE_SIM_NAO)[number];

/** A janela máxima da agenda, em dias. Um ano cobre "nos próximos N dias" real. */
export const DIAS_MAXIMOS_DA_AGENDA = 365;

/**
 * O que a condição "tem horário marcado" pede: a resposta, e — opcionalmente —
 * o prazo e o tipo de atendimento.
 *
 * `dias: null` = qualquer horário futuro (sem janela). `tipo: null` = qualquer
 * tipo. Os dois são do DESEJO da regra; a leitura (`fatos-do-contato.ts`) traz
 * o futuro inteiro e quem filtra é o avaliador.
 */
export type RegraDeHorario = {
  resposta: RespostaDeSimNao;
  dias: number | null;
  tipo: string | null;
};

/** Este campo é uma das condições do contato (e não um caminho do contexto)? */
export function ehCampoDoContato(field: string): field is CampoDoContato {
  return CAMPOS_DO_CONTATO_VALIDOS.has(field);
}

/**
 * `sim` · `sim|7` · `sim|7|Manutenção` → o que a condição pede. `null` quando o
 * texto não é nenhum destes — quem decide o que fazer com isso é o chamador
 * (o schema recusa; o avaliador trata como falso, nunca como "sim").
 *
 * O separador é `|` porque o campo do tipo é NOME de tipo de atendimento, e
 * nome de serviço tem vírgula, hífen e parêntese. Só os DOIS primeiros `|`
 * separam: o tipo é a última posição e é texto livre, então tudo depois do
 * segundo `|` é dele — inclusive outro `|` ("Corte|Barba"). Cortar em todo `|`
 * devolvia `null` para o que o próprio editor gravou (`nao|7|Corte|Barba`), e a
 * tela voltava o seletor para "Sim" (#3821). Os valores de antes (`sim`,
 * `sim|7`, `sim|7|Manutenção`, `sim||Consulta`) leem exatamente igual.
 */
export function lerValorDeHorario(valor: string): RegraDeHorario | null {
  if (typeof valor !== "string") return null;
  const [primeira = "", segunda, ...doTipo] = valor.split("|");
  const resposta = primeira.trim();
  const dias = segunda?.trim();
  const tipo = doTipo.length > 0 ? doTipo.join("|").trim() : undefined;
  if (!RESPOSTAS_DE_SIM_NAO.includes(resposta as RespostaDeSimNao)) return null;
  const janela = dias === undefined || dias === "" ? null : Number(dias);
  if (janela !== null && (!Number.isInteger(janela) || janela < 1 || janela > DIAS_MAXIMOS_DA_AGENDA)) {
    return null;
  }
  const nomeDoTipo = tipo === undefined || tipo === "" ? null : tipo.slice(0, 120);
  return { resposta: resposta as RespostaDeSimNao, dias: janela, tipo: nomeDoTipo };
}

/** O caminho de volta: o que o editor decompõe e remonta ao salvar. */
export function montarValorDeHorario(regra: RegraDeHorario): string {
  const partes: string[] = [regra.resposta];
  if (regra.dias !== null) partes.push(String(regra.dias));
  if (regra.tipo !== null && regra.tipo.trim() !== "") {
    // Sem dias, o tipo ocupa a segunda posição vazia: `sim||Manutenção`.
    if (regra.dias === null) partes.push("");
    partes.push(regra.tipo.trim());
  }
  return partes.join("|");
}

/** A frase que a pessoa lê quando a condição do contato está mal preenchida. */
export const RECUSAS_DA_CONDICAO_DO_CONTATO = {
  semResposta: "Escolha “sim” ou “não” nesta condição.",
  diasForaDaFaixa: `O prazo da agenda vai de 1 a ${DIAS_MAXIMOS_DA_AGENDA} dias.`,
  operador: "Esta condição só aceita “igual a” — sim ou não.",
} as const;

/**
 * A condição do contato está preenchida de um jeito que o motor entende?
 * `null` = sim; string = o que dizer a quem montou a regra (PT-BR, a mesma frase
 * na tela e na recusa da API).
 *
 * Uma condição de campo comum devolve `null`: esta função só opina sobre
 * `CAMPOS_DO_CONTATO`.
 */
export function validarCondicaoDoContato(cond: {
  field: string;
  op: string;
  value: string;
}): string | null {
  if (!ehCampoDoContato(cond.field)) return null;
  if (cond.op !== "eq") return RECUSAS_DA_CONDICAO_DO_CONTATO.operador;
  if (cond.field === CAMPOS_DO_CONTATO.followUpVivo) {
    const valor = cond.value.trim();
    return RESPOSTAS_DE_SIM_NAO.includes(valor as RespostaDeSimNao)
      ? null
      : RECUSAS_DA_CONDICAO_DO_CONTATO.semResposta;
  }
  const regra = lerValorDeHorario(cond.value);
  if (regra) return null;
  // Duas recusas diferentes porque o conserto é diferente: quem digitou "talvez"
  // errou a resposta; quem digitou "sim|999" errou o prazo.
  const [, dias] = cond.value.split("|").map((parte) => parte.trim());
  const janela = dias === undefined || dias === "" ? null : Number(dias);
  return janela !== null && Number.isFinite(janela)
    ? RECUSAS_DA_CONDICAO_DO_CONTATO.diasForaDaFaixa
    : RECUSAS_DA_CONDICAO_DO_CONTATO.semResposta;
}

/**
 * O valor com que a linha NASCE no editor quando a pessoa escolhe uma destas
 * condições — e o que preservar se o valor atual já serve para o campo novo
 * (trocar de campo não pode apagar um "não" que já estava escrito).
 */
export function valorPadraoDoCampo(campo: string, valorAtual: string): string | null {
  if (!ehCampoDoContato(campo)) return null;
  return validarCondicaoDoContato({ field: campo, op: "eq", value: valorAtual }) === null
    ? valorAtual
    : "sim";
}

/** Alguma condição da regra (inclusive dentro de grupo) pergunta pelo contato? */
export function usaFatosDoContato(conditions: Conditions): boolean {
  const olha = (nos: readonly ConditionNode[]): boolean =>
    nos.some((no) => (ehGrupo(no) ? olha(no.all ?? no.any ?? []) : ehCampoDoContato(no.field)));
  if (Array.isArray(conditions)) return olha(conditions);
  const grupo = conditions as ConditionGroup | null | undefined;
  return olha(grupo?.all ?? grupo?.any ?? []);
}

/**
 * As duas condições do contato como o editor as desenha: rótulo PT-BR (o mesmo
 * texto que vai para `t()` e para o dicionário), operador e o controle de valor
 * (`sim_nao`, ver `ValorDaCondicaoDoContato`).
 *
 * Mora AQUI, e não no editor, porque três telas leem a mesma tabela
 * (`RuleEditor`, `PainelDaCaixa`, `CaixaDaAutomacao`): uma lista por tela faria
 * a condição existir num editor e não no outro.
 */
export const CONDICOES_DO_CONTATO = [
  { value: CAMPOS_DO_CONTATO.followUpVivo, label: "Contato tem follow-up vivo", op: "eq", kind: "sim_nao" },
  {
    value: CAMPOS_DO_CONTATO.horarioMarcado,
    label: "Contato tem horário marcado",
    op: "eq",
    kind: "sim_nao",
  },
] as const satisfies ReadonlyArray<{
  value: string;
  label: string;
  op: ConditionOp;
  kind: "sim_nao";
}>;

/** Instante em ms — `NaN` para data inválida, que nunca casa janela nenhuma. */
function instante(iso: string): number {
  return Date.parse(iso);
}

/**
 * A avaliação das condições do contato. Os fatos vêm de fora (uma leitura por
 * avaliação, `fatos-do-contato.ts`); sem fatos, ou com o fato "não medido"
 * (`null`), a resposta é FALSA — não é "não tem", é "não sei", e uma regra que
 * decide no escuro é a loteria que estas condições vieram substituir.
 */
function avaliaCondicaoDoContato(
  cond: RuleCondition,
  fatos: FatosDoContato | null | undefined,
): boolean {
  if (!fatos || cond.op !== "eq") return false;

  if (cond.field === CAMPOS_DO_CONTATO.followUpVivo) {
    const querVivo = cond.value.trim() === "sim";
    return fatos.inscricao_viva === null ? false : fatos.inscricao_viva === querVivo;
  }

  const regra = lerValorDeHorario(cond.value);
  if (!regra || fatos.horarios === null) return false;

  const inicio = instante(fatos.agora);
  const limite = regra.dias === null ? null : inicio + regra.dias * 24 * 60 * 60 * 1000;
  const tipoPedido = regra.tipo === null ? null : normalizarParaContains(regra.tipo);

  const casa = fatos.horarios.some((horario) => {
    const quando = instante(horario.starts_at);
    if (!Number.isFinite(quando)) return false;
    if (limite !== null && quando > limite) return false;
    if (tipoPedido !== null && tipoPedido !== "") {
      const doHorario = horario.tipo === null ? "" : normalizarParaContains(horario.tipo);
      if (!doHorario.includes(tipoPedido)) return false;
    }
    return true;
  });

  return casa === (regra.resposta === "sim");
}

function matches(
  cond: RuleCondition,
  context: Record<string, unknown>,
  fatos?: FatosDoContato | null,
): boolean {
  // As condições do CONTATO não moram no contexto: quem responde é o fato lido
  // no banco, uma vez por avaliação.
  if (ehCampoDoContato(cond.field)) return avaliaCondicaoDoContato(cond, fatos);

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

function avaliaNo(
  no: ConditionNode,
  context: Record<string, unknown>,
  fatos?: FatosDoContato | null,
): boolean {
  if (ehGrupo(no)) {
    if (Array.isArray(no.all)) return no.all.every((filho) => avaliaNo(filho, context, fatos));
    if (Array.isArray(no.any)) return no.any.some((filho) => avaliaNo(filho, context, fatos));
    // Grupo sem chave: nada a exigir.
    return true;
  }
  return matches(no, context, fatos);
}

/**
 * Avalia as condições guardadas. A lista simples (formato antigo) vale como
 * `all`; um objeto `{all|any}` combina os filhos, recursivamente.
 *
 * `fatos` são os dados do CONTATO que não moram no evento — hoje a inscrição
 * viva e a agenda (#3814). Eles chegam prontos porque a leitura é do MOTOR, uma
 * vez por avaliação (`carregarFatosDoContato`), e esta função continua síncrona:
 * um `await` aqui dentro viraria uma consulta por regra no laço. Omitidos, as
 * condições do contato respondem FALSO — quem não mediu não decide.
 */
export function evaluateConditions(
  conditions: Conditions,
  context: Record<string, unknown>,
  fatos?: FatosDoContato | null,
): boolean {
  if (Array.isArray(conditions)) return conditions.every((no) => avaliaNo(no, context, fatos));
  return avaliaNo(conditions, context, fatos);
}

// ─── Schema (uma fonte para o avaliador e para a porta da API) ──────────────

export const conditionSchema = z
  .object({
    field: z.string().min(1).max(200),
    op: z.enum(OPS_DE_CONDICAO),
    value: z.string().max(500),
  })
  /**
   * A PORTA também confere a condição do contato (#3814).
   *
   * O campo é livre (`lead.custom_fields.x`), então o formato do valor não cabe
   * no schema de forma declarativa; o que dá para exigir é o que o AVALIADOR
   * entende. Sem esta conferência, `value: "talvez"` era gravado e a regra
   * simplesmente nunca casava — a mesma loteria de antes, agora com o banco
   * dizendo "salvo". A frase da recusa é a que a tela mostra (`t()` sobre a
   * mensagem), e por isso ela nasce em português aqui.
   */
  .superRefine((cond, ctx) => {
    const recusa = validarCondicaoDoContato(cond);
    if (recusa) ctx.addIssue({ code: z.ZodIssueCode.custom, message: recusa, path: [] });
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
