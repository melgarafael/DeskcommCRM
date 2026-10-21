/**
 * AS ETIQUETAS DO CONTATO — a comparação, o vocabulário e o autocompletar que a
 * ficha do contato oferece (issue #2732).
 *
 * ─── Por que o campo deixou de ser texto livre ──────────────────────────────
 *
 * A ficha gravava a etiqueta DIGITADA. Como ninguém digita igual duas vezes, a
 * organização acumulava `cliente-pagante`, `Cliente pagante` e `clientepagante`
 * — três etiquetas que quebram filtro, segmento de campanha e condição de
 * automação. O autocompletar oferece o que JÁ existe para o operador escolher
 * em vez de redigitar; e, quando o texto digitado casa com uma etiqueta
 * conhecida, é a grafia CONHECIDA que se grava.
 *
 * ─── Por que caixa E acento ─────────────────────────────────────────────────
 *
 * `normalizarTag` (`lib/contacts/tag-normalizada`) já iguala caixa, e é a régua
 * do que CHEGA ao banco. A comparação daqui é mais larga de propósito: quem
 * digita "sao paulo" espera encontrar a etiqueta "são paulo" da organização, e
 * deixar o acento fora da chave faria o autocompletar oferecer justamente uma
 * variante nova — o defeito que a issue veio consertar. A chave larga é só para
 * LER e ESCOLHER; o que se grava continua sendo a grafia existente.
 *
 * ─── Funções puras ──────────────────────────────────────────────────────────
 *
 * Nada aqui toca em React, rede ou banco: são as mesmas contas que o componente
 * (`components/contacts/EtiquetasDoContato`) e a tela usam, testáveis sem DOM.
 */
import { normalizarTag } from "@/lib/contacts/tag-normalizada";

/**
 * A chave de comparação: sem caixa e sem acento.
 *
 * `NFD` separa a letra do sinal diacrítico e a faixa U+0300–U+036F descarta os
 * sinais — a mesma conta em qualquer ambiente, sem depender de `\p{Diacritic}`
 * (que exige `u` e pode não existir na plataforma de destino).
 */
export function chaveDeComparacaoDeEtiqueta(tag: string): string {
  return tag
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

/**
 * As `canonical_tags` do funil — a MESMA leitura do card do Kanban
 * (`components/kanban/KanbanBoard`): só strings, nunca inventa campo.
 */
export function canonicalTagsDoFunil(
  settings: Record<string, unknown> | null | undefined,
): string[] {
  const raw = settings?.canonical_tags;
  return Array.isArray(raw) ? raw.filter((t): t is string => typeof t === "string") : [];
}

/**
 * A união do vocabulário da organização com as `canonical_tags` do funil, sem
 * repetir pela chave de comparação. A grafia que sobrevive é a da PRIMEIRA
 * fonte em que a etiqueta aparece (vocabulário antes do funil): é a forma que o
 * banco já guarda, e é ela que o clique grava.
 */
export function etiquetasConhecidas(fontes: {
  vocabulario?: readonly string[] | null;
  canonicalTags?: readonly string[] | null;
}): string[] {
  const vistas = new Set<string>();
  const saida: string[] = [];
  for (const fonte of [fontes.vocabulario ?? [], fontes.canonicalTags ?? []]) {
    for (const crua of fonte) {
      const nome = crua.trim();
      if (nome === "") continue;
      const k = chaveDeComparacaoDeEtiqueta(nome);
      if (vistas.has(k)) continue;
      vistas.add(k);
      saida.push(nome);
    }
  }
  return saida;
}

/**
 * A etiqueta CONHECIDA que casa com o texto digitado, ou `null` quando o texto
 * é novo. É o coração do critério "gravar reusa a etiqueta existente": com
 * "são paulo" no vocabulário, o texto "sao paulo" resolve para "são paulo".
 */
export function etiquetaExistentePara(
  conhecidas: readonly string[],
  digitado: string,
): string | null {
  const k = chaveDeComparacaoDeEtiqueta(digitado);
  if (k === "") return null;
  return conhecidas.find((t) => chaveDeComparacaoDeEtiqueta(t) === k) ?? null;
}

/**
 * As sugestões do autocompletar para o texto digitado.
 *
 * Texto vazio devolve as PRIMEIRAS conhecidas (até o teto): abrir o campo já
 * oferece o que existe, que é o ponto da issue. Com texto, filtra por trecho da
 * chave (`includes`) — "cli" encontra "cliente pagante" —, descarta o que já
 * está no contato e nunca repete pela chave.
 */
export function sugestoesDeEtiqueta(args: {
  conhecidas: readonly string[];
  selecionadas: readonly string[];
  digitado: string;
  limite?: number;
}): string[] {
  const jaTem = new Set(args.selecionadas.map(chaveDeComparacaoDeEtiqueta));
  const k = chaveDeComparacaoDeEtiqueta(args.digitado);
  return args.conhecidas
    .filter((t) => {
      const ck = chaveDeComparacaoDeEtiqueta(t);
      if (ck === "" || jaTem.has(ck)) return false;
      return k === "" ? true : ck.includes(k);
    })
    .slice(0, args.limite ?? 8);
}

/**
 * O que o campo deve gravar para um texto digitado, ou `null` se nada.
 *
 * Precedência: a etiqueta EXISTENTE vence sempre (reusa a grafia, não cria
 * variante). Sem ela, o texto novo vira etiqueta: este PR NÃO decide quem pode
 * criar (a trava de papel é o PR seguinte, valendo nos dois editores de
 * `contacts.tags`). Uma etiqueta já presente no contato nunca é readicionada.
 */
export function etiquetaParaGravar(args: {
  conhecidas: readonly string[];
  selecionadas: readonly string[];
  digitado: string;
}): string | null {
  const k = chaveDeComparacaoDeEtiqueta(args.digitado);
  if (k === "") return null;
  const jaTem = new Set(args.selecionadas.map(chaveDeComparacaoDeEtiqueta));
  if (jaTem.has(k)) return null;
  const existente = etiquetaExistentePara(args.conhecidas, args.digitado);
  if (existente) return existente;
  // A grafia de uma etiqueta NOVA passa pela régua do banco (a mesma do PATCH):
  // o que o autocompletar cria é o que o filtro `?tag=` casa.
  return normalizarTag(args.digitado);
}
