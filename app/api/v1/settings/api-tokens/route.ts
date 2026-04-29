/**
 * GET  /api/v1/settings/api-tokens — list tokens for the active org (no plaintext).
 * POST /api/v1/settings/api-tokens — create token. Plaintext returned UMA VEZ.
 *
 * Token format: `dsk_<8-hex-prefix>_<32-byte-random-base64url>`.
 * Stored as: prefix + sha256(plaintext) bytea — no reversible storage.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { ApiError } from "@/lib/api/types";
import { audit } from "@/lib/audit";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { createApiTokenSchema, validateRequest } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const SELECT_COLS =
  "id, name, prefix, scopes, last_used_at, expires_at, revoked_at, created_at";

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authUser = await loadAuthUser();
  if (!authUser) return fail("unauthenticated", "Auth required.", 401, { requestId });
  const activeOrg = await resolveActiveOrg(authUser);
  if (!activeOrg) return fail("forbidden_tenant", "Sem organização ativa.", 403, { requestId });
  if (ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) {
    return fail("forbidden_role", "Apenas admins podem ver tokens.", 403, { requestId });
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("api_tokens")
    .select(SELECT_COLS)
    .eq("organization_id", activeOrg.orgId)
    .order("created_at", { ascending: false });
  if (error) return fail("internal_error", error.message, 500, { requestId });
  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authUser = await loadAuthUser();
  if (!authUser) return fail("unauthenticated", "Auth required.", 401, { requestId });
  const activeOrg = await resolveActiveOrg(authUser);
  if (!activeOrg) return fail("forbidden_tenant", "Sem organização ativa.", 403, { requestId });
  if (ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) {
    return fail("forbidden_role", "Apenas admins podem criar tokens.", 403, { requestId });
  }

  let input;
  try {
    input = await validateRequest(createApiTokenSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  const prefix = `dsk_${randomBytes(4).toString("hex")}`;
  const secret = randomBytes(32).toString("base64url");
  const plaintext = `${prefix}_${secret}`;
  const tokenHash = createHash("sha256").update(plaintext).digest();

  const expiresAt = input.expires_in_days
    ? new Date(Date.now() + input.expires_in_days * 24 * 60 * 60 * 1000).toISOString()
    : null;

  const supabase = await createClient();
  const { data: created, error: insErr } = await supabase
    .from("api_tokens")
    .insert({
      organization_id: activeOrg.orgId,
      created_by: authUser.id,
      name: input.name,
      prefix,
      // bytea: pass as `\x<hex>` literal so PostgREST encodes correctly.
      token_hash: `\\x${tokenHash.toString("hex")}`,
      scopes: input.scopes,
      expires_at: expiresAt,
    })
    .select(SELECT_COLS)
    .single();

  if (insErr) return fail("internal_error", insErr.message, 500, { requestId });

  await audit({
    action: "token.created",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "api_token",
    resourceId: created.id,
    requestId,
    metadata: { name: input.name, prefix, scopes: input.scopes, expires_at: expiresAt },
  });

  return ok(
    {
      ...created,
      plaintext,
      _warning: "Salve este token agora — ele não será mostrado novamente.",
    },
    { status: 201, requestId },
  );
}
