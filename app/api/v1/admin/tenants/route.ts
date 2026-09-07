import { requireSupportWrite } from "@/lib/impersonate/support";
import { createTenantSchema } from "@/lib/schemas/tenant-creation";
import { issueInvite } from "@/lib/auth/issue-invite";
import { mfaEmDivida } from "@/lib/auth/server";
import { type NextRequest } from "next/server";
import { z } from "zod";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { createHash, randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const querySchema = z.object({
  q: z.string().optional(),
  status: z.enum(["active", "suspended", "onboarding", "redacted"]).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

// ---------------------------------------------------------------------------
// Cursor helpers
// ---------------------------------------------------------------------------

interface CursorPayload {
  created_at: string;
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
// GET /api/v1/admin/tenants
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const requestId = randomUUID();

  let adminCtx: Awaited<ReturnType<typeof requirePlatformAdmin>>;
  try {
    adminCtx = await requirePlatformAdmin();
  } catch {
    return fail("forbidden", "Platform admin required", 403, { requestId });
  }

  const parsed = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams.entries()));
  if (!parsed.success) {
    return fail("validation_error", "Invalid query params", 400, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const { q, status, cursor, limit } = parsed.data;
  const admin = createAdminClient();
  const cursorPayload = cursor ? decodeCursor(cursor) : null;

  let query = admin
    .from("organizations")
    .select(
      `
      id,
      slug,
      display_name,
      legal_name,
      cnpj,
      status,
      onboarded_at,
      suspended_at,
      created_at,
      user_count:user_organizations(count),
      conversations_count:conversations(count)
    `,
    )
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);

  if (status === "onboarding") {
    // Estado derivado: ativo no banco, onboarding ainda não concluído.
    query = query.eq("status", "active").is("onboarded_at", null);
  } else if (status) {
    query = query.eq("status", status);
  }

  if (q) {
    query = query.or(`display_name.ilike.%${q}%,slug::text.ilike.%${q}%,cnpj.ilike.%${q}%`);
  }

  if (cursorPayload) {
    query = query.or(
      `created_at.lt.${cursorPayload.created_at},and(created_at.eq.${cursorPayload.created_at},id.lt.${cursorPayload.id})`,
    );
  }

  const { data, error } = await query;

  if (error) {
    return fail("internal_error", "Query failed", 500, {
      requestId,
      details: error.message,
    });
  }

  const rows = data ?? [];
  const has_more = rows.length > limit;
  const page = has_more ? rows.slice(0, limit) : rows;

  const lastRow = page.at(-1);
  const nextCursor =
    has_more && lastRow
      ? encodeCursor({
          created_at: (lastRow as { created_at: string }).created_at,
          id: lastRow.id,
        })
      : null;

  void audit({
    action: "platform_admin.tenants_listed",
    actorUserId: adminCtx.user.id,
    actingAsPlatformAdmin: true,
    bypassedRls: true,
    requestId,
    metadata: {
      filters: { status: status ?? null, has_q: !!q },
      result_count: page.length,
    },
  });

  return ok(page, {
    requestId,
    meta: { has_more, cursor: nextCursor },
  });
}

// ---------------------------------------------------------------------------
// POST /api/v1/admin/tenants
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();

  let adminCtx: Awaited<ReturnType<typeof requirePlatformAdmin>>;
  try {
    adminCtx = await requirePlatformAdmin();
  } catch {
    return fail("forbidden", "Platform admin required", 403, { requestId });
  }

  if (adminCtx.platformAdmin.scope !== "full") {
    return fail("forbidden", "Seu acesso de suporte não permite criar organizações", 403, {
      requestId,
    });
  }
  if (await mfaEmDivida())
    return fail("mfa_required", "Confirme a verificação em duas etapas", 403, { requestId });
  const key = req.headers.get("Idempotency-Key") ?? randomUUID();
  if (!z.string().uuid().safeParse(key).success) {
    return fail("validation_error", "Idempotency-Key deve ser UUID", 400, { requestId });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("validation_error", "Invalid JSON body", 400, { requestId });
  }

  const parsed = createTenantSchema.safeParse(body);
  if (!parsed.success) {
    return fail("validation_error", "Invalid request body", 400, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const admin = createAdminClient();
  const request = { ...parsed.data, owner_email: parsed.data.owner_email.trim().toLowerCase() };
  const { data: org, error } = await admin.rpc("fn_create_tenant_with_owner", {
    p_actor: adminCtx.user.id,
    p_key: key,
    p_request: request,
    p_hash: createHash("sha256").update(JSON.stringify(request)).digest("hex"),
  });
  if (error) {
    if (error.code === "23505" || error.code === "22023") {
      return fail("conflict", "Slug já existe ou a chave foi usada com outros dados", 409, {
        requestId,
      });
    }
    return fail("internal_error", "Não foi possível criar a organização", 500, { requestId });
  }
  if (org.created) {
    await audit({
      action: "tenant.created_by_platform_admin",
      actorUserId: adminCtx.user.id,
      actingAsPlatformAdmin: true,
      bypassedRls: true,
      organizationId: org.id,
      resourceType: "organization",
      resourceId: org.id,
      requestId,
      metadata: {
        slug: org.slug,
        display_name: org.display_name,
        plan: request.plan,
        creator_role: "admin",
      },
    });
  }
  const ownerInvitation =
    request.owner_email === adminCtx.user.email?.trim().toLowerCase()
      ? null
      : await issueInvite({
          email: request.owner_email,
          role: "admin",
          interfaceSettings: request.owner_interface_settings,
          organizationId: org.id,
          orgName: org.display_name,
          inviterId: adminCtx.user.id,
          inviterName:
            adminCtx.user.user_metadata?.full_name ?? adminCtx.user.email ?? "Administrador",
          requestId,
          inviteId: org.invite_id,
          issuedAt: org.issued_at,
          dispatch: org.created,
        });
  return ok(
    {
      id: org.id,
      slug: org.slug,
      display_name: org.display_name,
      owner_invitation: ownerInvitation,
    },
    { status: 201, requestId },
  );
}
