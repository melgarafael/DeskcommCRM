/**
 * AS ABAS DA INBOX DE CADA PESSOA (#3313, item 2) — em que ordem aparecem e
 * quais ficam fora da faixa.
 *
 * A faixa tem sete abas (Automático, Fila, Minhas, Todas, Fechadas, Arquivadas,
 * Pessoal), sempre na mesma ordem, para todo mundo. Cada operação vive de um
 * pedaço dela: na agência que abriu a issue, o dia é Fila, Minhas e Automático,
 * nessa ordem, e o resto se abre de vez em quando. A issue pede reordenar e
 * ocultar, POR PESSOA, sem sumir caminho nenhum: a aba oculta continua num
 * menu "Mais" ao lado da faixa.
 *
 * ═══ A MESMA CASA E A MESMA RÉGUA DA LATERAL (#3008) ═══
 *
 * A preferência mora no `raw_user_meta_data` da pessoa, como a lateral do
 * contato (`lib/inbox/modulos-da-lateral.ts`): é escolha da PESSOA, não do
 * navegador — dois atendentes no mesmo computador não dividem a faixa, e o
 * mesmo atendente vê a sua faixa em qualquer máquina. Sem migration, sem RLS
 * nova: cada um grava a sua com a própria sessão (`updateUser`).
 *
 * As regras de leitura são as da lateral, de propósito — quem aprendeu uma leu
 * a outra:
 *
 *   - valor torto, id que não existe mais, id repetido → descartado;
 *   - aba que NÃO veio → entra no fim, VISÍVEL (aba nova no produto nasce
 *     aparecendo, como nasce para quem nunca configurou nada);
 *   - só `false` oculta: `"false"`, `0`, `null` ou ausente deixam a aba na faixa.
 *
 * E uma regra a mais, que a lateral não precisa: **a faixa nunca fica vazia.**
 * Uma lateral sem módulo é estranha; uma Inbox sem aba nenhuma não tem como
 * mostrar conversa. `normalizarAbas` devolve todas visíveis quando nenhuma veio
 * visível, e `faixaDaPessoa` faz o mesmo depois das permissões.
 *
 * ═══ PREFERÊNCIA NÃO É PERMISSÃO ═══
 *
 * Quem decide se a pessoa VÊ "Todas" e "Pessoal" é `visibleInboxTabs` (papel e
 * modo de visibilidade), e a rota decide o que cada aba devolve. A preferência
 * só ordena e oculta dentro do que já é permitido: uma "Todas" visível na
 * preferência de um atendente sem direito a ela não reaparece por causa disso.
 */

import { z } from "zod";

import type { InboxTab } from "@/components/inbox/InboxFilters";

/**
 * Os ids das abas, NA ORDEM PADRÃO DA FAIXA — a de `INBOX_TABS`
 * (`components/inbox/InboxFilters.tsx`, #2498 e #4434).
 *
 * Mora aqui, e não importado de lá, porque a action do servidor valida contra
 * esta lista e não pode puxar um componente `"use client"`. Os rótulos ficam lá
 * (um teste lê os pares da fonte). Que as duas listas sejam a MESMA, na mesma
 * ordem, é cobrado em `lib/inbox/abas-da-inbox.test.ts`: uma aba nova que só
 * entrasse lá não poderia ser gravada aqui.
 */
export const ABAS_DA_INBOX = [
  "ai",
  "unassigned",
  "mine",
  "all",
  "closed",
  "archived",
  "pessoal",
] as const satisfies readonly InboxTab[];

export type IdDaAba = (typeof ABAS_DA_INBOX)[number];

/** Onde a preferência é gravada no `raw_user_meta_data` da pessoa. */
export const CHAVE_DAS_ABAS = "abas_da_inbox";

export interface AbaDaPessoa {
  id: IdDaAba;
  visivel: boolean;
}

/**
 * O padrão do produto: todas as abas, na ordem de `ABAS_DA_INBOX`. Quem nunca
 * abriu o diálogo — a maioria — vê a faixa de hoje, byte a byte.
 *
 * Devolve cópias: quem chama reordena e oculta à vontade.
 */
export function abasPadrao(): AbaDaPessoa[] {
  return ABAS_DA_INBOX.map((id) => ({ id, visivel: true }));
}

export function ehIdDeAba(valor: unknown): valor is IdDaAba {
  return typeof valor === "string" && (ABAS_DA_INBOX as readonly string[]).includes(valor);
}

/**
 * O que a action de gravar aceita. Mora AQUI porque um arquivo `"use server"`
 * só pode exportar função async (a cicatriz do #2529, repetida no #3008).
 *
 * O teto de itens existe porque a lista é reescrita no metadata da pessoa: um
 * array enorme seria um jeito de inflar a própria conta.
 */
export const abaDaPessoaSchema = z.object({
  id: z.string().refine(ehIdDeAba, "aba_desconhecida"),
  visivel: z.boolean(),
});

export const abasDaInboxSchema = z
  .array(abaDaPessoaSchema)
  .min(1)
  .max(ABAS_DA_INBOX.length * 2);

/**
 * A lista COMPLETA, sem repetição e com pelo menos uma aba visível, a partir de
 * qualquer entrada. É a régua única das duas pontas: a leitura (metadata) e a
 * gravação (o que o diálogo manda).
 */
export function normalizarAbas(entrada: unknown): AbaDaPessoa[] {
  if (!Array.isArray(entrada)) return abasPadrao();

  const vistas = new Set<IdDaAba>();
  const ordenadas: AbaDaPessoa[] = [];
  for (const item of entrada) {
    if (typeof item !== "object" || item === null) continue;
    const cru = item as Record<string, unknown>;
    if (!ehIdDeAba(cru.id) || vistas.has(cru.id)) continue;
    vistas.add(cru.id);
    ordenadas.push({ id: cru.id, visivel: cru.visivel !== false });
  }

  if (ordenadas.length === 0) return abasPadrao();

  // As que faltaram entram no FIM e VISÍVEIS: aba nova no produto nasce
  // aparecendo, como nasceu para quem nunca configurou nada.
  for (const id of ABAS_DA_INBOX) {
    if (!vistas.has(id)) ordenadas.push({ id, visivel: true });
  }

  // Nenhuma visível não é um estado que a Inbox saiba desenhar: volta tudo à
  // faixa, NA ORDEM escolhida (a ordem continua sendo informação da pessoa).
  if (!ordenadas.some((a) => a.visivel)) return ordenadas.map((a) => ({ ...a, visivel: true }));
  return ordenadas;
}

/** Lê a preferência do `raw_user_meta_data` inteiro (a leitura tolerante mora num lugar só). */
export function lerAbasDaInbox(metadata: unknown): AbaDaPessoa[] {
  if (typeof metadata !== "object" || metadata === null) return abasPadrao();
  return normalizarAbas((metadata as Record<string, unknown>)[CHAVE_DAS_ABAS]);
}

/**
 * As abas que a pessoa PODE ver, na ordem dela — com a visibilidade de cada uma.
 *
 * `permitidas` vem de `visibleInboxTabs` (papel e modo de visibilidade). A
 * preferência só reordena e oculta dentro dela: aba não permitida não entra,
 * esteja como estiver na preferência. É a lista que o diálogo mostra.
 */
export function abasPermitidasNaOrdem(
  permitidas: readonly InboxTab[],
  abas: readonly AbaDaPessoa[],
): AbaDaPessoa[] {
  const normalizadas = normalizarAbas(abas);
  const doPapel = new Set<InboxTab>(permitidas);
  return normalizadas.filter((a) => doPapel.has(a.id));
}

export interface FaixaDaPessoa {
  /** As abas da faixa, na ordem da pessoa. Nunca vazia quando há permitidas. */
  faixa: InboxTab[];
  /** As que a pessoa ocultou — o menu "Mais" — na mesma ordem. */
  ocultas: InboxTab[];
}

/**
 * O que a barra desenha: a faixa e o menu "Mais".
 *
 * Se a pessoa deixou visível só uma aba que o papel dela não alcança mais (era
 * gerente e virou atendente, por exemplo), a faixa ficaria vazia. Nesse caso
 * todas as permitidas voltam para a faixa, na ordem dela.
 */
export function faixaDaPessoa(
  permitidas: readonly InboxTab[],
  abas: readonly AbaDaPessoa[],
): FaixaDaPessoa {
  const daPessoa = abasPermitidasNaOrdem(permitidas, abas);
  const faixa = daPessoa.filter((a) => a.visivel).map((a) => a.id);
  if (faixa.length === 0) return { faixa: daPessoa.map((a) => a.id), ocultas: [] };
  return { faixa, ocultas: daPessoa.filter((a) => !a.visivel).map((a) => a.id) };
}

/**
 * Junta o que o diálogo editou (só as permitidas, na ordem nova) com as abas que
 * o papel da pessoa não alcança, que voltam no fim com a visibilidade de antes.
 *
 * Sem isto, gravar o diálogo de um atendente apagaria a escolha que ele tinha
 * feito para "Todas" enquanto era gerente — e a regra "aba que não veio entra
 * visível" a faria reaparecer no dia em que o papel voltasse.
 */
export function juntarComAsForaDoPapel(
  editadas: readonly AbaDaPessoa[],
  gravadas: readonly AbaDaPessoa[],
): AbaDaPessoa[] {
  const editadasIds = new Set(editadas.map((a) => a.id));
  return [...editadas, ...normalizarAbas(gravadas).filter((a) => !editadasIds.has(a.id))];
}

/**
 * Move uma aba de `de` para `para`, sem perder nem duplicar ninguém. Fora de
 * faixa devolve a MESMA lista (mesma referência).
 */
export function moverAba(abas: readonly AbaDaPessoa[], de: number, para: number): AbaDaPessoa[] {
  if (de === para) return abas as AbaDaPessoa[];
  if (de < 0 || para < 0 || de >= abas.length || para >= abas.length) {
    return abas as AbaDaPessoa[];
  }
  const copia = [...abas];
  const [movida] = copia.splice(de, 1) as [AbaDaPessoa];
  copia.splice(para, 0, movida);
  return copia;
}
