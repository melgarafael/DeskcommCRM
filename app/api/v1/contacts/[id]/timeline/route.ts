/**
 * GET /api/v1/contacts/[id]/timeline
 *
 * Returns polymorphic timeline (`crm_lead_activities`) for a contact, merging
 * direct `contact_id` activities with activities attached to leads owned by
 * this contact. Two RLS-scoped queries client-side (supabase-js does not
 * compose `.or` with subqueries cleanly), then merge → sort → cursor-paginate.
 *
 * Filters:
 *   - type: repeatable query param (?type=order_created&type=message_inbound)
 *   - cursor: opaque base64 of (performed_at, id)
 *   - limit: 1..100 (default 50)
 *
 * ESTA ROTA NÃO É O DOSSIÊ DO NEGÓCIO. Ela é a vida do CONTATO, e por isso
 * soma os negócios dele — o que no dossiê de UM negócio apareceria como
 * história do irmão. O dossiê usa `leads/[id]/timeline`, ancorada no lead;
 * as duas dividem as peças de `lib/leads/timeline-query.ts` e divergem só na
 * cláusula, que é justamente onde a diferença mora.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { loadAuthUser } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";
import type { TimelineItem } from "@/lib/types/contacts";
import {
  TIMELINE_COLS,
  comNomeDoAtor,
  decodeCursor,
  encodeCursor,
  type Cursor,
} from "@/lib/leads/timeline-query";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { id: contactId } = await ctx.params;

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

  const url = new URL(req.url);
  const types = url.searchParams.getAll("type").filter(Boolean);
  const cursorRaw = url.searchParams.get("cursor");
  const limitRaw = url.searchParams.get("limit");
  const limit = Math.min(Math.max(parseInt(limitRaw ?? "50", 10) || 50, 1), 100);

  let cursor: Cursor | null = null;
  if (cursorRaw) {
    cursor = decodeCursor(cursorRaw);
    if (!cursor) {
      return fail("invalid_cursor", t("Cursor inválido."), 400, { requestId });
    }
  }

  // Verify contact accessible (RLS will filter); 404 if not.
  const { data: contactRow, error: cErr } = await supabase
    .from("contacts")
    .select("id")
    .eq("id", contactId)
    .maybeSingle();
  if (cErr) return fail("internal_error", cErr.message, 500, { requestId });
  if (!contactRow) return fail("not_found", t("Contato não encontrado."), 404, { requestId });

  // Resolve owned lead ids first.
  const { data: leadRows, error: lErr } = await supabase
    .from("crm_leads")
    .select("id")
    .eq("contact_id", contactId);
  if (lErr) return fail("internal_error", lErr.message, 500, { requestId });

  const leadIds = (leadRows ?? []).map((r) => (r as { id: string }).id);

  // Pull last (limit + 1) from each side to detect has_more after merge.
  // We over-fetch slightly to keep merge correct.
  const FETCH = limit + 1;

  const buildQuery = (column: "contact_id" | "lead_id", values: string | string[]) => {
    let q = supabase
      .from("crm_lead_activities")
      .select(TIMELINE_COLS)
      .order("performed_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(FETCH);
    if (Array.isArray(values)) q = q.in(column, values);
    else q = q.eq(column, values);
    if (types.length > 0) q = q.in("type", types);
    if (cursor) {
      q = q.or(
        `performed_at.lt.${cursor.performed_at},and(performed_at.eq.${cursor.performed_at},id.lt.${cursor.id})`,
      );
    }
    return q;
  };

  const directQ = buildQuery("contact_id", contactId);
  const leadQ =
    leadIds.length > 0 ? buildQuery("lead_id", leadIds) : Promise.resolve({ data: [], error: null });

  const [directRes, leadRes] = await Promise.all([directQ, leadQ]);

  if (directRes.error) {
    return fail("internal_error", directRes.error.message, 500, { requestId });
  }
  if ("error" in leadRes && leadRes.error) {
    return fail("internal_error", leadRes.error.message, 500, { requestId });
  }

  // Cast duplo porque a lista de colunas agora é montada com `join()`: o
  // supabase-js infere o shape a partir da STRING LITERAL do select, e a
  // string dinâmica apaga essa inferência (vira GenericStringError[]). A troca
  // é deliberada — perde-se uma inferência que já não protegia contra o bug
  // real (campo do tipo fora do SELECT compilava verde) e ganha-se o portão de
  // exaustividade acima, que protege.
  const merged = new Map<string, TimelineItem>();
  for (const row of (directRes.data ?? []) as unknown as TimelineItem[]) merged.set(row.id, row);
  for (const row of (leadRes.data ?? []) as unknown as TimelineItem[]) merged.set(row.id, row);

  const sorted = Array.from(merged.values()).sort((a, b) => {
    if (a.performed_at !== b.performed_at) {
      return a.performed_at < b.performed_at ? 1 : -1;
    }
    return a.id < b.id ? 1 : -1;
  });

  const hasMore = sorted.length > limit;
  const pageRows = hasMore ? sorted.slice(0, limit) : sorted;

  // Quem agiu, com NOME — resolvido aqui, na borda, e não na tela. É a mesma
  // decisão do dono agente no board: o dado de exibição viaja com a linha, em
  // vez de a tela ter de descobrir sozinha (e mostrar "Agente" genérico quando
  // não descobre). Sem filtro de is_active/archived: quem AGIU agiu, mesmo que
  // o agente tenha sido desligado depois.
  const page = await comNomeDoAtor(supabase, pageRows);
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last
      ? encodeCursor({ performed_at: last.performed_at, id: last.id })
      : null;

  return ok(page, {
    requestId,
    meta: { cursor: nextCursor, has_more: hasMore },
  });
}
