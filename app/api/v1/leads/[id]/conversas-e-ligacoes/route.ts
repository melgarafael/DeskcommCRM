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
}

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
    return ok<NumerosDoNegocio>({ numeros: [], conversas: [], ligacoes: [] }, {
      requestId,
      meta: { limite, tem_mais_conversas: false, tem_mais_ligacoes: false },
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
    return ok<NumerosDoNegocio>({ numeros: [], conversas: [], ligacoes: [] }, {
      requestId,
      meta: { limite, tem_mais_conversas: false, tem_mais_ligacoes: false },
    });
  }

  // 4/5 — TODAS as conversas dos números, numa consulta. `limite + 1` para
  // saber se há mais sem um `count(*)` (que pagaria a tabela inteira).
  const { data: conversasBrutas, error: conversasErr } = await supabase
    .from("conversations")
    .select("id, contact_id, last_message_preview, last_message_at, unread_count_for_assignee")
    .eq("organization_id", orgId)
    .in("contact_id", ids)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(limite + 1);
  if (conversasErr) return fail("internal_error", conversasErr.message, 500, { requestId });

  // 5/5 — TODAS as ligações dos números, também numa consulta.
  const { data: ligacoesBrutas, error: ligacoesErr } = await supabase
    .from("voice_calls")
    .select("id, contact_id, direction, status, started_at, answered_at, duration_ms, end_reason")
    .eq("organization_id", orgId)
    .in("contact_id", ids)
    .order("started_at", { ascending: false })
    .limit(limite + 1);
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

  return ok<NumerosDoNegocio>(
    { numeros, conversas, ligacoes },
    {
      requestId,
      meta: {
        limite,
        // O limite é do TOTAL: `limite` conversas e `limite` ligações, não
        // `limite` por pessoa.
        tem_mais_conversas: conversasTodas.length > limite,
        tem_mais_ligacoes: ligacoesTodas.length > limite,
      },
    },
  );
}
