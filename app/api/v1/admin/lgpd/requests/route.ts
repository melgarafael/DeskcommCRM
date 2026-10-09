/**
 * GET /api/v1/admin/lgpd/requests
 *
 * Cross-tenant list of lgpd_requests — platform admin only.
 * Service-role client (bypasses RLS). organization_id NEVER from body.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit";
import { computeRiskLevel } from "@/lib/lgpd/balde-de-sla";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const querySchema = z.object({
  status: z
    .enum(["received", "processing", "completed", "failed", "pending_review"])
    .optional(),
  request_type: z
    .enum(["redact", "data_request", "store_redact"])
    .optional(),
  risk_level: z.enum(["expired", "at_risk", "warning", "ok"]).optional(),
  tenant_id: z.string().uuid().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// ---------------------------------------------------------------------------
// Risk level
//
// `computeRiskLevel` mora em `lib/lgpd/balde-de-sla.ts`, ao lado do balde da
// organização: os dois selos classificam o mesmo `due_at` e têm de virar no mesmo
// instante. A versão que estava aqui comparava milissegundos e marcava `expired`
// às 21h da VÉSPERA do prazo — a causa e a medição estão no cabeçalho de lá.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Cursor helpers
// ---------------------------------------------------------------------------

interface CursorPayload {
  due_at: string | null;
  received_at: string;
  id: string;
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function decodeCursor(cursor: string): CursorPayload | null {
  try {
    return JSON.parse(Buffer.from(cursor, "base64url").toString("utf-8")) as CursorPayload;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// GET handler
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  let adminCtx: Awaited<ReturnType<typeof requirePlatformAdmin>>;
  try {
    adminCtx = await requirePlatformAdmin();
  } catch {
    return fail("forbidden", "Platform admin required.", 403, { requestId });
  }

  const parsed = querySchema.safeParse(
    Object.fromEntries(req.nextUrl.searchParams.entries()),
  );
  if (!parsed.success) {
    return fail("validation_error", "Parâmetros inválidos.", 400, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const { status, request_type, risk_level, tenant_id, cursor, limit } = parsed.data;
  const admin = createAdminClient();
  const cursorPayload = cursor ? decodeCursor(cursor) : null;

  let query = admin
    .from("lgpd_requests")
    .select(
      `
      id,
      organization_id,
      request_type,
      status,
      received_at,
      due_at,
      completed_at,
      contact_id,
      external_customer_id,
      attempts,
      emergency,
      scope,
      error_message,
      organizations!lgpd_requests_organization_id_fkey (
        display_name,
        slug
      )
      `,
    )
    .order("due_at", { ascending: true, nullsFirst: false })
    .order("received_at", { ascending: true })
    .limit(limit + 1);

  if (status) query = query.eq("status", status);
  if (request_type) query = query.eq("request_type", request_type);
  if (tenant_id) query = query.eq("organization_id", tenant_id);

  // Cursor: advance past last seen row
  if (cursorPayload) {
    if (cursorPayload.due_at) {
      query = query.or(
        `due_at.gt.${cursorPayload.due_at},and(due_at.eq.${cursorPayload.due_at},received_at.gt.${cursorPayload.received_at})`,
      );
    } else {
      query = query.gt("received_at", cursorPayload.received_at);
    }
  }

  const { data, error } = await query;

  if (error) {
    return fail("internal_error", error.message, 500, { requestId });
  }

  const rows = data ?? [];
  const has_more = rows.length > limit;
  const page = has_more ? rows.slice(0, limit) : rows;

  // Enrich with risk_level
  type OrgJoin = { display_name: string; slug: string } | { display_name: string; slug: string }[] | null;
  const enriched = page.map((r) => {
    const rawOrg = r.organizations as OrgJoin;
    const org = Array.isArray(rawOrg) ? (rawOrg[0] ?? null) : rawOrg;
    return {
      ...r,
      organizations: undefined,
      tenant_name: org?.display_name ?? null,
      tenant_slug: org?.slug ?? null,
      risk_level: computeRiskLevel(r.due_at, r.received_at),
    };
  });

  // Apply risk_level filter post-enrichment
  const filtered = risk_level
    ? enriched.filter((r) => r.risk_level === risk_level)
    : enriched;

  const lastRow = filtered.at(-1);
  const nextCursor =
    has_more && lastRow
      ? encodeCursor({
          due_at: lastRow.due_at,
          received_at: lastRow.received_at,
          id: lastRow.id,
        })
      : null;

  // Audit — fire and forget
  void audit({
    action: "platform_admin.lgpd_listed",
    actorUserId: adminCtx.user.id,
    actingAsPlatformAdmin: true,
    bypassedRls: true,
    requestId,
    metadata: {
      filters: {
        status: status ?? null,
        request_type: request_type ?? null,
        risk_level: risk_level ?? null,
        tenant_id: tenant_id ?? null,
      },
      result_count: filtered.length,
    },
  });

  return ok(filtered, {
    requestId,
    meta: { has_more: has_more && (!risk_level || filtered.length > 0), cursor: nextCursor },
  });
}
