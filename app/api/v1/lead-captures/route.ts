/**
 * GET /api/v1/lead-captures — o histórico de leads captados por formulário.
 *
 * Auth: sessão por cookie, papel `manager`+ (a mesma exigência da tela de
 * Webhooks). A RLS de `webhook_lead_captures` também exige `manager`, então a
 * porta HTTP e a porta do PostgREST concordam — o arquivo forense
 * (`webhook_events_log`) é o contra-exemplo: a rota pede manager e a policy é
 * org-flat, de modo que um `viewer` lê a mesma PII direto pela anon key.
 *
 * Paginação: keyset sobre (received_at DESC, id DESC).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";
import {
  decodeLeadCaptureCursor,
  encodeLeadCaptureCursor,
  leadCapturesQuerySchema,
} from "@/lib/schemas/lead-captures";

export const dynamic = "force-dynamic";

const COLUNAS =
  "id, received_at, source_name, webhook_source_id, lead_id, contact_id, outcome, reject_reason, " +
  "captured_name, captured_phone, captured_email, fields, utm, remote_ip, user_agent, origin";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", {
    requestId,
    resource: "lead_captures",
    allowPlatformAdmin: true,
  });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org: activeOrg } = authz;

  const params = Object.fromEntries(new URL(req.url).searchParams.entries());
  const parsed = leadCapturesQuerySchema.safeParse(params);
  if (!parsed.success) {
    return fail("validation_failed", t("Query inválida."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const q = parsed.data;

  const supabase = await createClient();
  let query = supabase
    .from("webhook_lead_captures")
    .select(COLUNAS)
    .eq("organization_id", activeOrg.orgId)
    .order("received_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(q.limit + 1);

  if (q.source_id) query = query.eq("webhook_source_id", q.source_id);
  if (q.outcome) query = query.eq("outcome", q.outcome);
  if (q.from) query = query.gte("received_at", q.from);
  if (q.to) query = query.lte("received_at", q.to);
  if (q.q) {
    // Busca no que a pessoa reconhece: nome, telefone, e-mail. `%` e `,` são
    // escapados porque o PostgREST separa os ramos do `or` por vírgula — um
    // termo com vírgula quebraria a expressão inteira em duas condições soltas.
    const termo = q.q.replace(/[%,()]/g, " ").trim();
    if (termo) {
      query = query.or(
        `captured_name.ilike.%${termo}%,captured_phone.ilike.%${termo}%,captured_email.ilike.%${termo}%`,
      );
    }
  }

  if (q.cursor) {
    const c = decodeLeadCaptureCursor(q.cursor);
    if (!c) return fail("invalid_cursor", t("Cursor inválido."), 400, { requestId });
    query = query.or(
      `received_at.lt.${c.received_at},and(received_at.eq.${c.received_at},id.lt.${c.id})`,
    );
  }

  const { data, error } = await query;
  if (error) return fail("internal_error", error.message, 500, { requestId });

  const rows = data ?? [];
  const hasMore = rows.length > q.limit;
  const page = hasMore ? rows.slice(0, q.limit) : rows;
  const last = page[page.length - 1] as { received_at: string; id: string } | undefined;
  const nextCursor =
    hasMore && last
      ? encodeLeadCaptureCursor({ received_at: last.received_at, id: last.id })
      : null;

  return ok(page, { requestId, meta: { cursor: nextCursor, has_more: hasMore } });
}
