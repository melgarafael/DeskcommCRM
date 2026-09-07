import { type NextRequest } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// T-04 (Spec 01 §3.4): platform_admins is managed exclusively by DBA via SQL.
// This route is strictly READ-ONLY. POST/PATCH/DELETE return 405 explicitly.
// ---------------------------------------------------------------------------

const T04_MESSAGE =
  "platform_admins é gerenciado exclusivamente via DBA (Spec 01 §3.4 T-04)";

// ---------------------------------------------------------------------------
// GET /api/v1/admin/platform-admins
// ---------------------------------------------------------------------------

export async function GET(_req: NextRequest) {
  const requestId = randomUUID();

  let adminCtx: Awaited<ReturnType<typeof requirePlatformAdmin>>;
  try {
    adminCtx = await requirePlatformAdmin();
  } catch {
    return fail("forbidden", "Platform admin required", 403, { requestId });
  }

  const admin = createAdminClient();

  // Step 1: fetch all platform_admins rows.
  //
  // SEM `id` no select: a tabela não tem essa coluna — a chave primária é
  // `user_id` (um usuário é admin no máximo uma vez). Pedir `id` fazia o
  // PostgREST responder 42703 "column platform_admins.id does not exist" → 400,
  // e a rota devolvia 500 em toda requisição. Era o PRIMEIRO erro da rota: ela
  // abortava aqui e nunca chegava na resolução de emails.
  const { data: paRows, error: paError } = await admin
    .from("platform_admins")
    .select(
      "user_id, granted_by, granted_at, scope, mfa_required, reason, revoked_at, revoked_by, revoke_reason",
    )
    .order("granted_at", { ascending: false });

  if (paError) {
    return fail("internal_error", "Query failed", 500, {
      requestId,
      details: paError.message,
    });
  }

  if (!paRows || paRows.length === 0) {
    void audit({
      action: "platform_admin.platform_admins_listed",
      actorUserId: adminCtx.user.id,
      actingAsPlatformAdmin: true,
      bypassedRls: true,
      requestId,
      metadata: { result_count: 0 },
    });
    return ok([], { requestId });
  }

  // Step 2: collect all user IDs that need resolution (user, granted_by, revoked_by)
  const userIdSet = new Set<string>();
  for (const row of paRows) {
    userIdSet.add(row.user_id);
    if (row.granted_by) userIdSet.add(row.granted_by);
    if (row.revoked_by) userIdSet.add(row.revoked_by);
  }
  const allUserIds = Array.from(userIdSet);

  // Step 3: resolve emails via the Auth Admin API.
  //
  // NÃO dá para consultar `auth.users` pelo PostgREST: `auth` não está entre os
  // schemas expostos (`supabase/config.toml` expõe `public`, `storage` e
  // `graphql_public`), então `.schema("auth")` devolve PGRST106 ("Invalid
  // schema: auth") e esta rota inteira virava 500 — a tela mostrava "Erro ao
  // carregar platform admins" mesmo com o service role correto. A Admin API
  // fala com o GoTrue direto e não depende do schema exposto.
  //
  // Um request por id, e não uma varredura do diretório: aqui N são os platform
  // admins mais quem concedeu/revogou o grant — unidades, não a base inteira.
  type AuthUser = {
    id: string;
    email: string | null;
    raw_user_meta_data: Record<string, unknown> | null;
  };

  const resolved = await Promise.all(
    allUserIds.map(async (uid) => {
      const { data, error } = await admin.auth.admin.getUserById(uid);
      if (error) {
        // Só 404/user_not_found é "esse usuário não existe" — aí o grant é
        // órfão (o Auth deletou o usuário, o grant não some sozinho) e a linha
        // sai com email null. Qualquer outro erro é indisponibilidade: o
        // GoTrue devolve AuthRetryableFetchError SEM lançar em 504/500/socket
        // fechado, e engolir isso publicava uma tela de admins sem e-mail
        // nenhum como se fosse o estado real da instalação.
        const naoExiste =
          error.status === 404 || error.code === "user_not_found";
        if (!naoExiste) return { unavailable: error.message } as const;
        return null;
      }
      if (!data?.user) return null;
      return {
        id: data.user.id,
        email: data.user.email ?? null,
        raw_user_meta_data:
          (data.user.user_metadata as Record<string, unknown> | null) ?? null,
      } satisfies AuthUser;
    }),
  );

  const indisponivel = resolved.find(
    (r): r is { unavailable: string } =>
      r !== null && "unavailable" in r,
  );
  if (indisponivel) {
    return fail("upstream_unavailable", "Auth indisponível", 503, {
      requestId,
      details: indisponivel.unavailable,
    });
  }

  const authMap = new Map<string, AuthUser>(
    resolved
      .filter((u): u is AuthUser => u !== null && "id" in u)
      .map((u) => [u.id, u]),
  );

  // Step 4: build enriched rows
  const data = paRows.map((pa) => {
    const targetUser = authMap.get(pa.user_id);
    const grantedByUser = pa.granted_by ? authMap.get(pa.granted_by) : null;
    const revokedByUser = pa.revoked_by ? authMap.get(pa.revoked_by) : null;

    return {
      // O front usa `id` como key do React. Como a PK da tabela é `user_id` e
      // ele já é único por linha, serve de identidade sem inventar coluna.
      id: pa.user_id,
      user_id: pa.user_id,
      user_email: targetUser?.email ?? null,
      user_name:
        (targetUser?.raw_user_meta_data?.full_name as string | undefined) ??
        null,
      granted_by: pa.granted_by,
      granted_by_email: grantedByUser?.email ?? null,
      granted_at: pa.granted_at,
      scope: pa.scope,
      mfa_required: pa.mfa_required,
      reason: pa.reason,
      revoked_at: pa.revoked_at,
      revoked_by: pa.revoked_by,
      revoked_by_email: revokedByUser?.email ?? null,
      revoke_reason: pa.revoke_reason,
    };
  });

  void audit({
    action: "platform_admin.platform_admins_listed",
    actorUserId: adminCtx.user.id,
    actingAsPlatformAdmin: true,
    bypassedRls: true,
    requestId,
    metadata: { result_count: data.length },
  });

  return ok(data, { requestId });
}

// ---------------------------------------------------------------------------
// T-04 enforcement: POST / PATCH / DELETE return 405 explicitly
// ---------------------------------------------------------------------------

function methodNotAllowed() {
  return new Response(
    JSON.stringify({
      error: {
        code: "method_not_allowed",
        message: T04_MESSAGE,
      },
    }),
    {
      status: 405,
      headers: {
        "Content-Type": "application/json",
        Allow: "GET",
      },
    },
  );
}

export function POST() {

  return methodNotAllowed();
}

export function PATCH() {

  return methodNotAllowed();
}

export function DELETE() {

  return methodNotAllowed();
}

export type PlatformAdminRow = Awaited<
  ReturnType<typeof GET>
> extends Response
  ? never
  : never;
