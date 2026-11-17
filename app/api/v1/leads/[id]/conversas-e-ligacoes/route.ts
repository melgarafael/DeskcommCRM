/**
 * GET /api/v1/leads/[id]/conversas-e-ligacoes — as conversas e as ligações de
 * TODOS os números do cliente (#3669, fatia 1 de LEITURA).
 *
 * ─── O defeito, como ele aparece na tela ────────────────────────────────────
 *
 * Na venda B2B o cliente não tem um telefone, tem vários: o dono, o comprador, o
 * gerente, o fixo da loja. Cada um escreve de um WhatsApp diferente e cada um é
 * um contato próprio (`uniq_contacts_org_phone`). O negócio guarda UM deles em
 * `crm_leads.contact_id`, e era só esse que o dossiê enxergava: o bloco de
 * conversa mostrava a conversa do principal, e a lista de ligações simplesmente
 * não existia. Quem falou pelo segundo número ficava fora do negócio.
 *
 * ─── O que esta rota faz, e o que ela NÃO faz ───────────────────────────────
 *
 * LÊ. Reaproveita as "Pessoas relacionadas" que já existem — `crm_lead_links`
 * com `target_kind='contact'`, `link_kind='related'` (#1506/#3083), a mesma
 * fonte da rota `contatos-relacionados` — e devolve, numa resposta só, as
 * conversas e as ligações do contato principal MAIS as dos relacionados. Sem
 * tabela nova, sem migration, e sem tocar a ingestão do WhatsApp nem o envio:
 * cada número continua sendo um contato com a própria conversa, e a resposta
 * continua saindo pelo número certo.
 *
 * ─── SEM N+1, e por que isso é requisito e não elegância ────────────────────
 *
 * O negócio de uma distribuidora tem quatro, cinco números. Consultar por
 * pessoa transformaria o dossiê em 2N+3 idas ao banco a cada abertura, num
 * painel que já busca timeline, campos e tarefas. Aqui são **cinco consultas
 * fixas**, independentes do número de pessoas: o negócio, os vínculos, as
 * pessoas, as conversas e as ligações. O `.in(contact_id, [...])` carrega todos
 * os números de uma vez, e o limite é do TOTAL da lista — não por contato.
 *
 * ─── TRÊS DEFESAS QUE O TESTE PRENDE ────────────────────────────────────────
 *
 *  1. O NEGÓCIO VEM PELA RLS. É a leitura do `crm_leads` que prova de quem é o
 *     negócio (nunca o corpo nem a query). Sem ele, 404 — e nenhuma consulta a
 *     conversa ou ligação é feita: quem não vê o negócio não vê os números dele.
 *  2. ORG EXPLÍCITA EM TODA CONSULTA (doutrina multi-tenancy da CLAUDE.md), não
 *     só RLS: o vínculo, as pessoas, as conversas e as ligações levam
 *     `organization_id`.
 *  3. DEFESA ALÉM DA RLS NO VÍNCULO. `crm_lead_links.target_id` não é FK — é o
 *     preço do `target_kind` polimórfico —, então um link forjado pode apontar
 *     para contato de outra organização. A linha do contato é conferida contra a
 *     org do negócio antes de entrar na lista: contato de outra org não entra, e
 *     sem entrar não vira id na consulta de conversas nem na de ligações.
 *
 * ─── A LINHA DO TEMPO, E O CURSOR ───────────────────────────────────────────
 *
 * A primeira entrega desta fatia (PR #4117) trouxe as DUAS listas — conversas e
 * ligações — e o defeito de tela estava resolvido. Faltava o que a vendedora
 * realmente lê: a ordem dos fatos. Duas listas separadas obrigam a cruzar data
 * de conversa com data de ligação de cabeça, e o limite de 50 por lista não
 * deixa claro o que ficou de fora. Esta entrega acrescenta `linha_do_tempo`:
 * conversas e ligações de TODOS os números, intercaladas, mais recente primeiro,
 * cada item com o número de quem falou, e paginação por CURSOR (`?cursor=`).
 *
 * O cursor é de CHAVE, não offset: ele carrega a data, o tipo e o id do último
 * item entregue, e a página seguinte pede só o que vem DEPOIS dele
 * (`<`, `<=` e o desempate por id). Com offset, uma mensagem nova durante a
 * rolagem empurraria a lista e repetiria item; com chave, não.
 *
 * ─── O QUE FICA DE FORA, E POR QUÊ ──────────────────────────────────────────
 *
 *  - **Lápide de fusão** (`contacts.is_merged_into`): as conversas pertencem ao
 *    id em que nasceram, e a fusão de contatos não as reponta (medido: nenhum
 *    UPDATE de `conversations.contact_id` no caminho de merge). Resolver a lápide
 *    aqui ESCONDERIA o histórico do número fundido, que é o oposto do que esta
 *    rota promete. Juntar cartões duplicados é a fatia 2 da issue.
 *  - **Contato pessoal** (`is_personal`): o filtro existe nas listas globais
 *    (inbox e histórico de chamadas) para não misturar vida pessoal com
 *    atendimento. Aqui a pessoa foi ligada ao negócio por AÇÃO EXPLÍCITA do
 *    operador — a lista de pessoas relacionadas é do negócio —, e filtrar por
 *    baixo deixaria a tela mentindo sobre um vínculo que a própria tela mostra.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { loadAuthUser } from "@/lib/auth/server";
import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";

import { ALVO_DE_CONTATO, VINCULO_DE_CONTATO } from "../contatos-relacionados/route";

export const dynamic = "force-dynamic";

/** Quantas conversas e quantas ligações, no TOTAL da lista (não por contato). */
export const LIMITE_PADRAO = 50;
export const TETO_DO_LIMITE = 100;

/** Uma pessoa do negócio e o número por onde ela fala. */
export interface NumeroDoNegocio {
  contact_id: string;
  nome: string | null;
  /** Ausente quando anonimizado: a cascata LGPD já redigiu o número. */
  telefone?: string;
  papel: "principal" | "relacionado";
  /** Texto livre do vínculo ("comprador", "fixo da loja"); `null` no principal. */
  papel_do_vinculo: string | null;
}

/** Uma conversa de um dos números — o atalho que a vendedora procura. */
export interface ConversaDoNumero {
  id: string;
  contact_id: string;
  previa: string | null;
  ultima_em: string | null;
  nao_lidas: number;
}

/** Uma ligação de um dos números. */
export interface LigacaoDoNumero {
  id: string;
  contact_id: string;
  direcao: "inbound" | "outbound";
  /** Houve `answered_at`: a chamada foi atendida (o "perdida" do upstream). */
  atendida: boolean;
  /** Ainda tocando/conectada — a lista mostra o estado, não esconde a linha. */
  em_andamento: boolean;
  comecou_em: string;
  duracao_ms: number | null;
  motivo_do_fim: string | null;
}

export interface NumerosDoNegocio {
  numeros: NumeroDoNegocio[];
  conversas: ConversaDoNumero[];
  ligacoes: LigacaoDoNumero[];
  /** Conversas e ligações intercaladas por data — a leitura principal da tela. */
  linha_do_tempo: ItemDaLinhaDoTempo[];
}

export type TipoDeItem = "conversa" | "ligacao";

/**
 * Um fato da vida do cliente: ou a conversa de um número, ou a ligação de um
 * número. O `contact_id`/`nome`/`telefone` são a ORIGEM do item — o requisito
 * de a vendedora saber de quem era aquele WhatsApp.
 */
export interface ItemDaLinhaDoTempo {
  tipo: TipoDeItem;
  id: string;
  contact_id: string;
  nome: string | null;
  telefone?: string;
  /** Data do fato (ISO). `null` só na conversa que nunca teve mensagem. */
  em: string | null;
  conversa?: ConversaDoNumero;
  ligacao?: LigacaoDoNumero;
}

/** O que o cursor de chave carrega: a posição do último item entregue. */
interface CursorDaLinhaDoTempo {
  em: string | null;
  tipo: TipoDeItem;
  id: string;
}

/** `null` = não veio cursor; objeto = veio e é válido. */
type CursorLido = { ok: true; cursor: CursorDaLinhaDoTempo | null } | { ok: false };

/** Conversa antes de ligação quando as datas empatam — ordem estável, e só isso. */
const ORDEM_DO_TIPO: Record<TipoDeItem, number> = { conversa: 0, ligacao: 1 };

interface RouteCtx {
  params: Promise<{ id: string }>;
}

interface LinhaDeContato {
  id: string;
  organization_id: string;
  name: string | null;
  display_name: string | null;
  phone_number: string | null;
  is_anonymized: boolean;
}

/** `metadata.papel` é texto livre, com teto de 40 (a mesma régua do POST). */
function papelDo(metadata: unknown): string | null {
  const bruto = (metadata as { papel?: unknown } | null | undefined)?.papel;
  return typeof bruto === "string" && bruto.trim() !== "" ? bruto.trim() : null;
}

function limiteDaQuery(raw: string | null): number {
  const n = Number(raw ?? LIMITE_PADRAO);
  if (!Number.isFinite(n)) return LIMITE_PADRAO;
  return Math.min(TETO_DO_LIMITE, Math.max(1, Math.trunc(n)));
}

function codificarCursor(cursor: CursorDaLinhaDoTempo): string {
  return Buffer.from(JSON.stringify({ e: cursor.em, t: cursor.tipo, i: cursor.id }), "utf8").toString(
    "base64url",
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DO_BANCO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Cursor de fora é dado de fora: string vazia, base64 quebrado, tipo inventado e
 * data impossível viram 400 (`invalid_cursor`), não uma página silenciosamente
 * errada. Id sem forma de uuid também não passa — o id só entra em filtro.
 */
function lerCursor(bruto: string | null): CursorLido {
  if (!bruto) return { ok: true, cursor: null };
  let cru: unknown;
  try {
    cru = JSON.parse(Buffer.from(bruto, "base64url").toString("utf8"));
  } catch {
    return { ok: false };
  }
  const c = cru as { e?: unknown; t?: unknown; i?: unknown } | null;
  if (!c || typeof c !== "object") return { ok: false };
  if (c.t !== "conversa" && c.t !== "ligacao") return { ok: false };
  if (typeof c.i !== "string" || !UUID.test(c.i)) return { ok: false };
  const em = c.e;
  // Só o ISO que o PostgREST devolve: `new Date` aceitaria "Jan 1 2026 (a,b)", e a
  // vírgula e os parênteses iriam crus para dentro do `or()`. O texto original é
  // o que segue, para não perder os microssegundos.
  if (
    em !== null &&
    (typeof em !== "string" || !ISO_DO_BANCO.test(em) || Number.isNaN(new Date(em).getTime()))
  ) {
    return { ok: false };
  }
  return { ok: true, cursor: { em: em as string | null, tipo: c.t, id: c.i } };
}

/** O mínimo do builder do Supabase que o cursor usa. */
interface ConsultaFiltravel {
  or(filtro: string): ConsultaFiltravel;
  lt(coluna: string, valor: string): ConsultaFiltravel;
  lte(coluna: string, valor: string): ConsultaFiltravel;
  is(coluna: string, valor: null): ConsultaFiltravel;
}

/**
 * Aplica o cursor de CHAVE numa das duas consultas.
 *
 * A ordem é `em` desc → tipo asc → id desc. Sabendo de que tipo é o cursor, a
 * condição de "o que vem depois" se reduz por fonte: fonte de tipo maior aceita
 * `<=` (empate de data passa inteiro); fonte de tipo menor só aceita `<`; e a
 * mesma fonte precisa do desempate por id. A conversa sem mensagem tem data
 * nula e fica no FIM — por isso o `is.null` entra na fonte de conversa.
 *
 * `null` = não há nada depois do cursor nesta fonte: nem vale ir ao banco.
 */
function aplicarCursor<C extends ConsultaFiltravel>(
  consulta: C,
  tipo: TipoDeItem,
  coluna: string,
  cursor: CursorDaLinhaDoTempo | null,
): C | null {
  if (!cursor) return consulta;

  const meu = ORDEM_DO_TIPO[tipo];
  const dele = ORDEM_DO_TIPO[cursor.tipo];

  // Cursor sem data: só a conversa sem mensagem chega aqui, e ela é a última.
  if (cursor.em === null) {
    if (meu !== dele) return null;
    return consulta.is(coluna, null).lt("id", cursor.id) as C;
  }

  const semData = tipo === "conversa" ? `,${coluna}.is.null` : "";

  if (meu > dele) return consulta.or(`${coluna}.lte.${cursor.em}${semData}`) as C;
  if (meu < dele) {
    return (tipo === "conversa"
      ? consulta.or(`${coluna}.lt.${cursor.em},${coluna}.is.null`)
      : consulta.lt(coluna, cursor.em)) as C;
  }
  return consulta.or(
    `${coluna}.lt.${cursor.em},and(${coluna}.eq.${cursor.em},id.lt.${cursor.id})${semData}`,
  ) as C;
}

/** `em` desc, tipo asc, id desc — o mesmo critério da consulta e do cursor. */
function compararItens(a: ItemDaLinhaDoTempo, b: ItemDaLinhaDoTempo): number {
  if (a.em !== b.em) {
    if (a.em === null) return 1;
    if (b.em === null) return -1;
    // Data numérica, não string: o PostgREST devolve `timestamptz` com offset e
    // fração variável, e comparar texto erraria a ordem nesses casos.
    return Date.parse(b.em) - Date.parse(a.em);
  }
  if (a.tipo !== b.tipo) return ORDEM_DO_TIPO[a.tipo] - ORDEM_DO_TIPO[b.tipo];
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

export async function GET(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id: leadId } = await ctx.params;

  const supabase = await createClient();
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) {
    return fail("unauthenticated", "Auth required.", 401, { requestId });
  }
  const authUser = await loadAuthUser();
  const t = (texto: string) => traduzir(texto, authUser?.idioma ?? "pt-BR");

  const limite = limiteDaQuery(new URL(req.url).searchParams.get("limit"));
  const cursorLido = lerCursor(new URL(req.url).searchParams.get("cursor"));
  if (!cursorLido.ok) {
    return fail("invalid_cursor", t("Cursor de paginação inválido."), 400, { requestId });
  }
  const cursor = cursorLido.cursor;

  // 1/5 — O NEGÓCIO, pela RLS do caller. É esta linha que prova a org.
  const { data: lead, error: leadErr } = await supabase
    .from("crm_leads")
    .select("id, organization_id, contact_id")
    .eq("id", leadId)
    .maybeSingle();
  if (leadErr) return fail("internal_error", leadErr.message, 500, { requestId });
  if (!lead) return fail("not_found", t("Negócio não encontrado."), 404, { requestId });
  const { organization_id: orgId, contact_id: principalId } = lead as {
    organization_id: string;
    contact_id: string | null;
  };

  // 2/5 — As "Pessoas relacionadas" (#1506/#3083), com filtro de org explícito.
  const { data: links, error: linksErr } = await supabase
    .from("crm_lead_links")
    .select("target_id, metadata")
    .eq("lead_id", leadId)
    .eq("organization_id", orgId)
    .eq("target_kind", ALVO_DE_CONTATO)
    .eq("link_kind", VINCULO_DE_CONTATO)
    // Ordem explícita: sem ela, a lista da tela ficaria por conta da ordem
    // física da tabela.
    .order("created_at", { ascending: true });
  if (linksErr) return fail("internal_error", linksErr.message, 500, { requestId });

  const vinculos = (links ?? []) as unknown as { target_id: string; metadata: unknown }[];
  const alvos = [...new Set([...(principalId ? [principalId] : []), ...vinculos.map((l) => l.target_id)])];

  // Sem contato nenhum o negócio não tem número — e sem número não há conversa
  // nem ligação para consultar. Resposta vazia, e não 404: o negócio existe.
  if (alvos.length === 0) {
    return ok<NumerosDoNegocio>({ numeros: [], conversas: [], ligacoes: [], linha_do_tempo: [] }, {
      requestId,
      meta: { limite, tem_mais_conversas: false, tem_mais_ligacoes: false, tem_mais: false, proximo_cursor: null },
    });
  }

  // 3/5 — As pessoas, todas de uma vez.
  const { data: contatos, error: contatosErr } = await supabase
    .from("contacts")
    .select("id, organization_id, name, display_name, phone_number, is_anonymized")
    .eq("organization_id", orgId)
    .in("id", alvos);
  if (contatosErr) return fail("internal_error", contatosErr.message, 500, { requestId });

  const porId = new Map<string, LinhaDeContato>();
  for (const c of (contatos ?? []) as unknown as LinhaDeContato[]) porId.set(c.id, c);

  const numeros: NumeroDoNegocio[] = [];
  const vistos = new Set<string>();
  const empurrar = (contactId: string, papel: "principal" | "relacionado", papelDoVinculo: string | null) => {
    if (vistos.has(contactId)) return;
    const contato = porId.get(contactId);
    // Alvo apagado (ou de outra organização, o link forjado): sem linha de
    // contato não entra — e sem entrar não vai para `.in()` de conversa nenhuma.
    if (!contato || contato.organization_id !== orgId) return;
    vistos.add(contactId);
    const anonimizado = contato.is_anonymized === true;
    numeros.push({
      contact_id: contato.id,
      nome: nomeDoContato(contato),
      papel,
      papel_do_vinculo: papelDoVinculo,
      ...(!anonimizado && contato.phone_number ? { telefone: contato.phone_number } : {}),
    });
  };

  // O principal primeiro: é o número do card, e a tela abre por ele.
  if (principalId) empurrar(principalId, "principal", null);
  for (const vinculo of vinculos) {
    empurrar(vinculo.target_id, "relacionado", papelDo(vinculo.metadata));
  }

  const ids = numeros.map((n) => n.contact_id);
  if (ids.length === 0) {
    return ok<NumerosDoNegocio>({ numeros: [], conversas: [], ligacoes: [], linha_do_tempo: [] }, {
      requestId,
      meta: { limite, tem_mais_conversas: false, tem_mais_ligacoes: false, tem_mais: false, proximo_cursor: null },
    });
  }

  // 4/5 — TODAS as conversas dos números, numa consulta. `limite + 1` para
  // saber se há mais sem um `count(*)` (que pagaria a tabela inteira). Com
  // cursor, o filtro é de CHAVE: a página seguinte continua de onde a anterior
  // parou, sem offset e sem repetir item quando chega mensagem nova.
  const consultaDeConversas = aplicarCursor(
    supabase
      .from("conversations")
      .select("id, contact_id, last_message_preview, last_message_at, unread_count_for_assignee")
      .eq("organization_id", orgId)
      .in("contact_id", ids),
    "conversa",
    "last_message_at",
    cursor,
  );
  const { data: conversasBrutas, error: conversasErr } = consultaDeConversas
    ? await consultaDeConversas
        .order("last_message_at", { ascending: false, nullsFirst: false })
        .order("id", { ascending: false })
        .limit(limite + 1)
    : { data: [], error: null };
  if (conversasErr) return fail("internal_error", conversasErr.message, 500, { requestId });

  // 5/5 — TODAS as ligações dos números, também numa consulta.
  const consultaDeLigacoes = aplicarCursor(
    supabase
      .from("voice_calls")
      .select("id, contact_id, direction, status, started_at, answered_at, duration_ms, end_reason")
      .eq("organization_id", orgId)
      .in("contact_id", ids),
    "ligacao",
    "started_at",
    cursor,
  );
  const { data: ligacoesBrutas, error: ligacoesErr } = consultaDeLigacoes
    ? await consultaDeLigacoes
        .order("started_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(limite + 1)
    : { data: [], error: null };
  if (ligacoesErr) return fail("internal_error", ligacoesErr.message, 500, { requestId });

  const conversasTodas = (conversasBrutas ?? []) as unknown as {
    id: string;
    contact_id: string;
    last_message_preview: string | null;
    last_message_at: string | null;
    unread_count_for_assignee: number | null;
  }[];
  const ligacoesTodas = (ligacoesBrutas ?? []) as unknown as {
    id: string;
    contact_id: string;
    direction: string;
    status: string;
    started_at: string;
    answered_at: string | null;
    duration_ms: number | null;
    end_reason: string | null;
  }[];

  const conversas: ConversaDoNumero[] = conversasTodas.slice(0, limite).map((c) => ({
    id: c.id,
    contact_id: c.contact_id,
    previa: c.last_message_preview,
    ultima_em: c.last_message_at,
    nao_lidas: c.unread_count_for_assignee ?? 0,
  }));

  const ligacoes: LigacaoDoNumero[] = ligacoesTodas.slice(0, limite).map((l) => ({
    id: l.id,
    contact_id: l.contact_id,
    direcao: l.direction === "inbound" ? "inbound" : "outbound",
    atendida: l.answered_at !== null,
    em_andamento: l.status !== "ended",
    comecou_em: l.started_at,
    duracao_ms: l.duration_ms,
    motivo_do_fim: l.end_reason,
  }));

  // A LINHA DO TEMPO — a leitura principal. Conversas e ligações de todos os
  // números num só fio, mais recente primeiro; cada item carrega o número de
  // quem falou. As duas listas acima ficam como recorte por tipo, para quem já
  // consome a rota sem a linha do tempo.
  const porContactId = new Map(numeros.map((n) => [n.contact_id, n]));
  const origemDe = (contactId: string) => {
    const pessoa = porContactId.get(contactId);
    return {
      contact_id: contactId,
      nome: pessoa?.nome ?? null,
      ...(pessoa?.telefone ? { telefone: pessoa.telefone } : {}),
    };
  };

  const linhaCompleta: ItemDaLinhaDoTempo[] = [
    ...conversasTodas.map((c) => ({
      tipo: "conversa" as const,
      id: c.id,
      ...origemDe(c.contact_id),
      em: c.last_message_at,
      conversa: {
        id: c.id,
        contact_id: c.contact_id,
        previa: c.last_message_preview,
        ultima_em: c.last_message_at,
        nao_lidas: c.unread_count_for_assignee ?? 0,
      } satisfies ConversaDoNumero,
    })),
    ...ligacoesTodas.map((l) => ({
      tipo: "ligacao" as const,
      id: l.id,
      ...origemDe(l.contact_id),
      em: l.started_at,
      ligacao: {
        id: l.id,
        contact_id: l.contact_id,
        direcao: l.direction === "inbound" ? ("inbound" as const) : ("outbound" as const),
        atendida: l.answered_at !== null,
        em_andamento: l.status !== "ended",
        comecou_em: l.started_at,
        duracao_ms: l.duration_ms,
        motivo_do_fim: l.end_reason,
      } satisfies LigacaoDoNumero,
    })),
  ].sort(compararItens);

  const linhaDoTempo = linhaCompleta.slice(0, limite);
  const ultimo = linhaDoTempo[linhaDoTempo.length - 1];
  // Sem mais nada depois desta página não há cursor: um cursor que aponta para
  // o vazio só faria a tela pedir uma página vazia.
  const proximoCursor =
    linhaCompleta.length > limite && ultimo
      ? codificarCursor({ em: ultimo.em, tipo: ultimo.tipo, id: ultimo.id })
      : null;

  return ok<NumerosDoNegocio>(
    { numeros, conversas, ligacoes, linha_do_tempo: linhaDoTempo },
    {
      requestId,
      meta: {
        limite,
        // O limite é do TOTAL: `limite` conversas e `limite` ligações, não
        // `limite` por pessoa.
        tem_mais_conversas: conversasTodas.length > limite,
        tem_mais_ligacoes: ligacoesTodas.length > limite,
        // E o da linha do tempo é o do fio inteiro, misturado.
        tem_mais: linhaCompleta.length > limite,
        proximo_cursor: proximoCursor,
      },
    },
  );
}
