"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { createClient } from "@/lib/supabase/server";
import { ensureTenantForUser } from "@/lib/auth/provision";
import { decidirConviteDoSignup } from "@/lib/auth/convite-no-signup";
import { organizationNameSchema } from "@/lib/auth/schemas";
import { audit } from "@/lib/audit";
import { authRateLimited, AUTH_LIMITS } from "@/lib/auth/rate-limit";

export type RecoverOrganizationResult =
  | { ok: true }
  | {
      ok: false;
      error: "validation_error" | "rate_limited" | "invite_pending" | "provision_failed";
    };

/**
 * Recupera o caminho de primeiro acesso quando o email foi confirmado, mas o
 * provisionamento não deixou uma membership ativa. A action nunca aceita
 * organization_id, role ou qualquer outro vínculo do cliente.
 */
export async function recoverOrganization(name: string): Promise<RecoverOrganizationResult> {
  const parsed = organizationNameSchema.safeParse(name);
  if (!parsed.success) return { ok: false, error: "validation_error" };

  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (activeOrg) redirect("/app/inbox");

  const supabase = await createClient();
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();
  if (!authUser) return { ok: false, error: "provision_failed" };

  const decisao = decidirConviteDoSignup(authUser);
  if (decisao.tipo !== "provisionar") {
    void audit({
      action: "auth.signup_provision_recusado",
      actorUserId: authUser.id,
      metadata: { motivo: decisao.tipo === "convite" ? "convite_pendente" : decisao.motivo },
    });
    return { ok: false, error: "invite_pending" };
  }

  if (await authRateLimited("org_recovery", authUser.id, AUTH_LIMITS.org_recovery)) {
    return { ok: false, error: "rate_limited" };
  }

  try {
    const provisioned = await ensureTenantForUser(
      {
        id: authUser.id,
        email: authUser.email,
        user_metadata: { ...authUser.user_metadata, org_name: parsed.data },
      },
      { source: "recovery" },
    );
    if (!provisioned.organizationId) return { ok: false, error: "provision_failed" };
  } catch (error) {
    void audit({
      action: "auth.signup_provision_recovery_failed",
      actorUserId: authUser.id,
      metadata: { reason: error instanceof Error ? error.message : String(error) },
    });
    return { ok: false, error: "provision_failed" };
  }

  revalidatePath("/app/inbox");
  redirect("/onboarding/welcome");
}
