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

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const ENROLLMENT_STATUSES = [
  "active",
  "waiting_reply",
  "paused_handoff",
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
  return c.display_name?.trim() || c.name?.trim() || c.phone_number || "Contato sem nome";
}

function embedded<T>(v: T | T[] | null): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

export interface QueueRow {
  source: "enrollment" | "promise";
  id: string;
  contact: { id: string; name: string };
  flow_name: string | null;
  node_or_reason: string;
  next_fire_at: string | null;
  status: string;
  detail: string | null;
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
  const authz = await requireRole("viewer", { requestId, resource: "followup_queue" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const sp = req.nextUrl.searchParams;
  const status = sp.get("status");
  if (status !== null && !ENROLLMENT_STATUSES.includes(status as (typeof ENROLLMENT_STATUSES)[number])) {
    return fail("invalid_request", "status inválido.", 400, { requestId });
  }
  const pointerId = sp.get("pointer_id");
  const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (pointerId !== null && !UUID_RX.test(pointerId)) {
    return fail("invalid_request", "pointer_id inválido.", 400, { requestId });
  }
  const q = sp.get("q")?.trim() || null;
  const cursorRaw = sp.get("cursor");
  const cursor = cursorRaw ? decodeCursor(cursorRaw) : null;
  if (cursorRaw && !cursor) {
    return fail("invalid_request", "cursor inválido.", 400, { requestId });
  }
  const limitParam = Number(sp.get("limit") ?? "20");
  const limit = Number.isFinite(limitParam) ? Math.min(100, Math.max(1, Math.trunc(limitParam))) : 20;

  const supabase = await createClient();

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
      .eq("organization_id", activeOrg.orgId)
      .or(`name.ilike.%${safeQ}%,display_name.ilike.%${safeQ}%,phone_number.ilike.%${safeQ}%`)
      .limit(500); // ponytail: fila é escala MVP; sobe se virar hot path
    if (cErr) return fail("internal_error", cErr.message, 500, { requestId });
    contactIds = (matches ?? []).map((m) => m.id);
    if (contactIds.length === 0) {
      return ok<QueueRow[]>([], { requestId, meta: { cursor: null, has_more: false } });
    }
  }

  const skipPromises = status !== null || pointerId !== null;

  // --- fonte 1: enrollments ---
  let enrollQuery = supabase
    .from("followup_enrollments")
    .select(
      `id, pointer_id, contact_id, status, current_node_id, next_eval_at, outcome, updated_at,
       contacts:contact_id(id, name, display_name, phone_number),
       followup_flow_pointers:pointer_id(name)`,
    )
    .eq("organization_id", activeOrg.orgId)
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
    .select("id, contact_id, next_run_at, enabled, payload, contacts:contact_id(id, name, display_name, phone_number)")
    .eq("organization_id", activeOrg.orgId)
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

  const enrollRows: QueueRow[] = (enrollRes.data ?? []).map((e) => {
    const contact = embedded(e.contacts as ContactRow | ContactRow[] | null);
    const pointer = embedded(e.followup_flow_pointers as { name: string } | { name: string }[] | null);
    return {
      source: "enrollment",
      id: e.id,
      contact: { id: e.contact_id, name: resolveContactName(contact) },
      flow_name: pointer?.name ?? null,
      node_or_reason: e.current_node_id,
      next_fire_at: e.next_eval_at,
      status: e.status,
      detail: e.outcome,
    };
  });

  const promiseRows: QueueRow[] = (promiseRes.data ?? []).map((j) => {
    const contact = embedded(j.contacts as ContactRow | ContactRow[] | null);
    const payload = (j.payload ?? {}) as { reason?: string; promise?: string };
    return {
      source: "promise",
      id: j.id,
      contact: { id: j.contact_id, name: resolveContactName(contact) },
      flow_name: null,
      node_or_reason: payload.reason ?? "—",
      next_fire_at: j.next_run_at,
      status: j.enabled ? "agendada" : "concluída",
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
