/**
 * Server guard for /admin/* (Super-Admin Platform sub-product).
 *
 * Flow:
 *  1. Validate JWT via getUser() (NEVER getSession on backend per CLAUDE.md).
 *  2. Confirm row in platform_admins (active = no revoked_at).
 *  3. Enforce MFA AAL2 if `mfa_required` (default true for platform admins).
 *
 * Redirects:
 *  - no user        → /login?next=/admin
 *  - no row         → /admin/forbidden
 *  - aal1 + required → /login/mfa?next=/admin
 *
 * The middleware already does an early `fn_is_platform_admin` RPC check;
 * this helper performs the authoritative server-side validation inside the
 * /admin layout (where redirects are cheap, DB calls are allowed in Node
 * runtime, and we have access to AAL state).
 */
import { redirect } from "next/navigation";
import type { NextResponse } from "next/server";
import type { User } from "@supabase/supabase-js";
import { fail, type ApiError } from "@/lib/api/wrappers";
import { EscritaDePlatformAdminNegada } from "@/lib/auth/recusa-de-escrita-de-admin";
import { mfaEmDivida } from "@/lib/auth/server";
import { createClient } from "@/lib/supabase/server";

export interface PlatformAdminInfo {
  user_id: string;
  scope: string;
  mfa_required: boolean;
}

export interface PlatformAdminContext {
  user: User;
  platformAdmin: PlatformAdminInfo;
}

export async function requirePlatformAdmin(): Promise<PlatformAdminContext> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/login?next=/admin");
  }

  // platform_admins RLS: only platform admins read; non-admins get null → forbid.
  const { data: paRow } = await supabase
    .from("platform_admins")
    .select("user_id, scope, mfa_required, revoked_at")
    .eq("user_id", user.id)
    .is("revoked_at", null)
    .maybeSingle();

  if (!paRow) {
    redirect("/admin/forbidden");
  }

  if (paRow.mfa_required) {
    const { data: aalData } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aalData?.currentLevel !== "aal2") {
      redirect("/login/mfa?next=/admin");
    }
  }

  return {
    user,
    platformAdmin: {
      user_id: paRow.user_id,
      scope: paRow.scope,
      mfa_required: paRow.mfa_required,
    },
  };
}

// A classe mora no módulo sem `next/*` para o formulário ler a mesma frase.
export { EscritaDePlatformAdminNegada };

/**
 * `requirePlatformAdmin()` + o que a ESCRITA exige e a leitura não:
 * `scope === 'full'` (o `support_readonly` lê o painel e nada muda) e sessão sem
 * dívida de MFA (quem TEM fator prova nesta sessão).
 *
 * `requirePlatformAdmin` devolvia o scope sem impor; só `admin/tenants` POST e as
 * rotas de extensões conferiam. A cerca `tests/unit/admin-escrita-exige-scope-full.test.ts`
 * exige este helper em todo handler de escrita e em toda server action de admin.
 *
 * Mantém o contrato de `requirePlatformAdmin` (quem não é platform admin é
 * REDIRECIONADO); as duas recusas novas LANÇAM `EscritaDePlatformAdminNegada`.
 */
export async function requirePlatformAdminEscrita(): Promise<PlatformAdminContext> {
  const ctx = await requirePlatformAdmin();
  if (ctx.platformAdmin.scope !== "full") {
    throw new EscritaDePlatformAdminNegada("forbidden_scope");
  }
  if (await mfaEmDivida()) {
    throw new EscritaDePlatformAdminNegada("mfa_required");
  }
  return ctx;
}

/**
 * Resposta de rota para o que `requirePlatformAdminEscrita` lançou. A recusa
 * nomeada vira o seu código; o resto (redirect de quem não é platform admin,
 * sessão ilegível) vira o 403 `forbidden` que as rotas de admin já davam.
 */
export function falhaDaEscritaDePlatformAdmin(
  err: unknown,
  requestId?: string,
  mensagemDeRecusa = "Platform admin required",
): NextResponse<ApiError> {
  if (err instanceof EscritaDePlatformAdminNegada) return fail(err.code, err.message, 403, { requestId });
  return fail("forbidden", mensagemDeRecusa, 403, { requestId });
}
