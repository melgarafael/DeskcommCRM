/**
 * GET /api/v1/ai/followups/queue — fila unificada (any member): UNION de
 *   `followup_enrollments` (estado vivo do motor) + `cron_jobs` (promessas
 *   `schedule_followup`, kind='at' + job_kind='followup_turn'). Union feita em
 *   app-code (2 queries + merge), não SQL nativo — schema-simples o bastante
 *   pra não justificar uma function nova; ver nota de ordenação/cursor abaixo.
 *
 * Ordenação: (next_fire_at asc, nulls last, id asc) — terminal/disparado
 *   (next_eval_at ou next_run_at null) vai pro fim. Cursor = a chave de
 *   ordenação da última linha emitida (`{next_fire_at, id}`), aplicada a
 *   AMBAS as fontes na próxima página (seek pagination).
 *
 * Correção da paginação sobre união: cada página busca `limit+1` linhas de
 *   CADA fonte (já filtradas pelo cursor), concatena e reordena — o clássico
 *   "k-way merge lookahead": a (limit+1)-ésima menor linha GLOBAL está
 *   garantida dentro do top-(limit+1) de pelo menos uma das janelas
 *   individuais, então essa janela é suficiente pra decidir `has_more` e o
 *   próximo cursor sem pular nem duplicar linha entre páginas.
 *
 * `status`/`pointer_id` só existem pra enrollment — quando setados, a fonte
 *   de promessas é pulada (nenhuma promessa tem esses atributos, então
 *   nenhuma promessa poderia bater no filtro mesmo se buscada).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { ok, fail } from "@/lib/api/wrappers";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";
import { statusDaPromessaNaFila } from "@/lib/followup/retorno";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const ENROLLMENT_STATUSES = [
  "active",
  "waiting_reply",
  "dormente",
  "paused_handoff",
  "paused_manual",
  "coletando",
  "completed",
  "cancelled",
  "dead",
] as const;

interface CursorPayload {
  next_fire_at: string | null;
  id: string;
}

function encodeCursor(p: CursorPayload): string {
  return Buffer.from(JSON.stringify(p), "utf8").toString("base64url");
}
function decodeCursor(raw: string): CursorPayload | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<CursorPayload>;
    if (typeof parsed.id !== "string") return null;
    if (parsed.next_fire_at !== null && typeof parsed.next_fire_at !== "string") return null;
    return { next_fire_at: parsed.next_fire_at ?? null, id: parsed.id };
  } catch {
    return null;
  }
}

interface ContactRow {
  id: string;
  name: string | null;
  display_name: string | null;
  phone_number: string | null;
}

function resolveContactName(c: ContactRow | null): string {
  if (!c) return "Contato removido";
  return rotuloDoContato(c);
}

function embedded<T>(v: T | T[] | null): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

/** Linha crua de enrollment: na sessão traz os embeds; no token vem sem eles. */
interface EnrollmentBruto {
  id: string;
  pointer_id: string | null;
  contact_id: string;
  status: string;
  current_node_id: string;
  next_eval_at: string | null;
  outcome: string | null;
  agent_id: string | null;
  contacts?: ContactRow | ContactRow[] | null;
  followup_flow_pointers?: { name: string } | { name: string }[] | null;
  ai_agents?: { name: string } | { name: string }[] | null;
}

/** Linha crua de promessa (`cron_jobs`): na sessão traz o embed de contato; no token vem sem ele. */
interface PromiseBruta {
  id: string;
  contact_id: string;
  next_run_at: string | null;
  enabled: boolean;
  cancelled_at: string | null;
  last_error: string | null;
  payload: unknown;
  contacts?: ContactRow | ContactRow[] | null;
}

export interface QueueRow {
  source: "enrollment" | "promise";
  id: string;
  contact: { id: string; name: string };
  flow_name: string | null;
  /** Agente publicado que armou o fluxo (Task 8.6); null p/ promessas e enrollments sem agente pinado. */
  agent_name: string | null;
  node_or_reason: string;
  next_fire_at: string | null;
  status: string;
  detail: string | null;
}

/** Linha de enrollment (com embeds de contato/fluxo/agente) → QueueRow. Pura p/ teste. */
export function enrollmentToQueueRow(e: {
  id: string;
  contact_id: string;
  current_node_id: string;
  next_eval_at: string | null;
  status: string;
  outcome: string | null;
  contacts: ContactRow | ContactRow[] | null;
  followup_flow_pointers: { name: string } | { name: string }[] | null;
  ai_agents: { name: string } | { name: string }[] | null;
}): QueueRow {
  const contact = embedded(e.contacts);
  const pointer = embedded(e.followup_flow_pointers);
  const agent = embedded(e.ai_agents);
  return {
    source: "enrollment",
    id: e.id,
    contact: { id: e.contact_id, name: resolveContactName(contact) },
    flow_name: pointer?.name ?? null,
    agent_name: agent?.name ?? null,
    node_or_reason: e.current_node_id,
    next_fire_at: e.next_eval_at,
    status: e.status,
    detail: e.outcome,
  };
}

/** Chave de ordenação/seek: null (infinito) sempre vem por último. */
function sortCompare(a: { next_fire_at: string | null; id: string }, b: { next_fire_at: string | null; id: string }): number {
  if (a.next_fire_at === null && b.next_fire_at === null) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  if (a.next_fire_at === null) return 1;
  if (b.next_fire_at === null) return -1;
  const ta = Date.parse(a.next_fire_at);
  const tb = Date.parse(b.next_fire_at);
  if (ta !== tb) return ta - tb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "followup_queue",
    role: "viewer",
    scope: "config:read",
    tokenRole: "admin",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "followup_queue", requestId);
  if (teto) return teto;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);
  const { organizationId } = authz;

  const sp = req.nextUrl.searchParams;
  const status = sp.get("status");
  if (status !== null && !ENROLLMENT_STATUSES.includes(status as (typeof ENROLLMENT_STATUSES)[number])) {
    return fail("invalid_request", t("status inválido."), 400, { requestId });
  }
  const pointerId = sp.get("pointer_id");
  const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (pointerId !== null && !UUID_RX.test(pointerId)) {
    return fail("invalid_request", t("pointer_id inválido."), 400, { requestId });
  }
  const q = sp.get("q")?.trim() || null;
  const cursorRaw = sp.get("cursor");
  const cursor = cursorRaw ? decodeCursor(cursorRaw) : null;
  if (cursorRaw && !cursor) {
    return fail("invalid_request", t("cursor inválido."), 400, { requestId });
  }
  const limitParam = Number(sp.get("limit") ?? "20");
  const limit = Number.isFinite(limitParam) ? Math.min(100, Math.max(1, Math.trunc(limitParam))) : 20;

  const supabase = authz.supabase;

  // `q` resolve pra um conjunto de contact_ids ANTES das 2 queries (mesma
  // filtragem aplicada às duas fontes). Sem match → resultado vazio direto.
  let contactIds: string[] | null = null;
  if (q) {
    // Mesmo escape de %/_ de conversations/_handler.ts (LIKE wildcards literais).
    // Diferente de lá (um `.ilike()` fluente só), aqui os 3 termos vão dentro de
    // um `.or()` cru — vírgula/parêntese são delimitadores do PRÓPRIO DSL do
    // `.or()`, então também são removidos (não só escapados) pra um termo de
    // busca nunca injetar uma condição extra na string do filtro.
    const safeQ = q.replace(/[%_]/g, (m) => `\\${m}`).replace(/[,()]/g, " ");
    const { data: matches, error: cErr } = await supabase
      .from("contacts")
      .select("id")
      .eq("organization_id", organizationId)
      .or(`name.ilike.%${safeQ}%,display_name.ilike.%${safeQ}%,phone_number.ilike.%${safeQ}%`)
      .limit(500); // ponytail: fila é escala MVP; sobe se virar hot path
    if (cErr) return fail("internal_error", cErr.message, 500, { requestId });
    // Ficha cujo telefone EXTRA casa o termo também entra: a busca acima olha só o
    // principal. Mesmo critério de texto, filtrado por organização e pela lápide.
    const { data: extras, error: eErr } = await supabase
      .from("contact_phones")
      .select("contact_id, contacts!inner(id)")
      .eq("organization_id", organizationId)
      .eq("contacts.organization_id", organizationId)
      .is("contacts.is_merged_into", null)
      .ilike("phone_number", `%${safeQ}%`)
      .limit(500);
    if (eErr) return fail("internal_error", eErr.message, 500, { requestId });
    contactIds = [
      ...new Set([
        ...(matches ?? []).map((m) => m.id),
        ...((extras ?? []) as { contact_id: string }[]).map((r) => r.contact_id),
      ]),
    ];
    if (contactIds.length === 0) {
      return ok<QueueRow[]>([], { requestId, meta: { cursor: null, has_more: false } });
    }
  }

  const skipPromises = status !== null || pointerId !== null;

  // --- fonte 1: enrollments ---
  let enrollQuery = supabase
    .from("followup_enrollments")
    .select(
      authz.via === "session"
        ? `id, pointer_id, contact_id, status, current_node_id, next_eval_at, outcome, updated_at, agent_id,
       contacts:contact_id(id, name, display_name, phone_number),
       followup_flow_pointers:pointer_id(name),
       ai_agents:agent_id(name)`
        : "id, pointer_id, contact_id, status, current_node_id, next_eval_at, outcome, updated_at, agent_id",
    )
    .eq("organization_id", organizationId)
    .order("next_eval_at", { ascending: true, nullsFirst: false })
    .order("id", { ascending: true })
    .limit(limit + 1);
  if (status !== null) enrollQuery = enrollQuery.eq("status", status);
  if (pointerId !== null) enrollQuery = enrollQuery.eq("pointer_id", pointerId);
  if (contactIds) enrollQuery = enrollQuery.in("contact_id", contactIds);
  if (cursor) {
    enrollQuery =
      cursor.next_fire_at !== null
        ? enrollQuery.or(
            `next_eval_at.gt.${cursor.next_fire_at},and(next_eval_at.eq.${cursor.next_fire_at},id.gt.${cursor.id}),next_eval_at.is.null`,
          )
        : enrollQuery.is("next_eval_at", null).gt("id", cursor.id);
  }

  // --- fonte 2: promessas (cron_jobs kind='at' + job_kind='followup_turn') ---
  let promiseQuery = supabase
    .from("cron_jobs")
    .select(
      authz.via === "session"
        ? "id, contact_id, next_run_at, enabled, cancelled_at, last_error, payload, contacts:contact_id(id, name, display_name, phone_number)"
        : "id, contact_id, next_run_at, enabled, cancelled_at, last_error, payload",
    )
    .eq("organization_id", organizationId)
    .eq("kind", "at")
    .eq("job_kind", "followup_turn")
    .order("next_run_at", { ascending: true, nullsFirst: false })
    .order("id", { ascending: true })
    .limit(limit + 1);
  if (contactIds) promiseQuery = promiseQuery.in("contact_id", contactIds);
  if (cursor) {
    promiseQuery =
      cursor.next_fire_at !== null
        ? promiseQuery.or(
            `next_run_at.gt.${cursor.next_fire_at},and(next_run_at.eq.${cursor.next_fire_at},id.gt.${cursor.id}),next_run_at.is.null`,
          )
        : promiseQuery.is("next_run_at", null).gt("id", cursor.id);
  }

  const [enrollRes, promiseRes] = await Promise.all([
    enrollQuery,
    skipPromises ? Promise.resolve({ data: [], error: null }) : promiseQuery,
  ]);
  if (enrollRes.error) return fail("internal_error", enrollRes.error.message, 500, { requestId });
  if (promiseRes.error) return fail("internal_error", promiseRes.error.message, 500, { requestId });

  const enrollBrutos = (enrollRes.data ?? []) as unknown as EnrollmentBruto[];
  const promiseBrutas = (promiseRes.data ?? []) as unknown as PromiseBruta[];

  // Token: a service role ignora RLS e o embed do PostgREST não filtra por
  // organização. Por isso o relacionado vem em consulta própria, com
  // `organization_id` na mão; relacionado de outra organização não entra e
  // vira null. Sessão: já vem embutido (RLS da sessão).
  const contatosPorId = new Map<string, ContactRow>();
  const fluxosPorId = new Map<string, { name: string }>();
  const agentesPorId = new Map<string, { name: string }>();
  if (authz.via === "token") {
    const idsDeContato = [
      ...new Set([...enrollBrutos.map((e) => e.contact_id), ...promiseBrutas.map((j) => j.contact_id)]),
    ];
    const idsDeFluxo = [...new Set(enrollBrutos.map((e) => e.pointer_id).filter((v): v is string => v !== null))];
    const idsDeAgente = [...new Set(enrollBrutos.map((e) => e.agent_id).filter((v): v is string => v !== null))];

    if (idsDeContato.length > 0) {
      const { data, error } = await supabase
        .from("contacts")
        .select("id, name, display_name, phone_number")
        .in("id", idsDeContato)
        .eq("organization_id", organizationId);
      if (error) return fail("internal_error", error.message, 500, { requestId });
      for (const c of (data ?? []) as ContactRow[]) contatosPorId.set(c.id, c);
    }
    if (idsDeFluxo.length > 0) {
      const { data, error } = await supabase
        .from("followup_flow_pointers")
        .select("id, name")
        .in("id", idsDeFluxo)
        .eq("organization_id", organizationId);
      if (error) return fail("internal_error", error.message, 500, { requestId });
      for (const f of (data ?? []) as Array<{ id: string; name: string }>) {
        fluxosPorId.set(f.id, { name: f.name });
      }
    }
    if (idsDeAgente.length > 0) {
      const { data, error } = await supabase
        .from("ai_agents")
        .select("id, name")
        .in("id", idsDeAgente)
        .eq("organization_id", organizationId);
      if (error) return fail("internal_error", error.message, 500, { requestId });
      for (const a of (data ?? []) as Array<{ id: string; name: string }>) {
        agentesPorId.set(a.id, { name: a.name });
      }
    }
  }

  const enrollRows: QueueRow[] = enrollBrutos.map((e) =>
    enrollmentToQueueRow({
      id: e.id,
      contact_id: e.contact_id,
      current_node_id: e.current_node_id,
      next_eval_at: e.next_eval_at,
      status: e.status,
      outcome: e.outcome,
      contacts: authz.via === "session" ? (e.contacts ?? null) : (contatosPorId.get(e.contact_id) ?? null),
      followup_flow_pointers:
        authz.via === "session"
          ? (e.followup_flow_pointers ?? null)
          : e.pointer_id !== null
            ? (fluxosPorId.get(e.pointer_id) ?? null)
            : null,
      ai_agents:
        authz.via === "session"
          ? (e.ai_agents ?? null)
          : e.agent_id !== null
            ? (agentesPorId.get(e.agent_id) ?? null)
            : null,
    }),
  );

  const promiseRows: QueueRow[] = promiseBrutas.map((j) => {
    const contact =
      authz.via === "session" ? embedded(j.contacts ?? null) : (contatosPorId.get(j.contact_id) ?? null);
    const payload = (j.payload ?? {}) as { reason?: string; promise?: string };
    return {
      source: "promise",
      id: j.id,
      contact: { id: j.contact_id, name: resolveContactName(contact) },
      flow_name: null,
      agent_name: null,
      node_or_reason: payload.reason ?? "—",
      next_fire_at: j.next_run_at,
      // `enabled=false` significava DUAS coisas — disparou ou alguém desmarcou —
      // e a fila chamava as duas de "concluída". Com o cancelamento pela tela
      // (0102), isso viraria uma mentira frequente: a pessoa clicaria em cancelar
      // e leria "concluída", como se o cliente tivesse recebido a mensagem.
      status: statusDaPromessaNaFila(j),
      detail: payload.promise ?? null,
    };
  });

  const merged = [...enrollRows, ...promiseRows].sort(sortCompare);
  const hasMore = merged.length > limit;
  const page = merged.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeCursor({ next_fire_at: last.next_fire_at, id: last.id }) : null;

  return ok<QueueRow[]>(page, { requestId, meta: { cursor: nextCursor, has_more: hasMore } });
}
