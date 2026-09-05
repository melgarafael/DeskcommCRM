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
 * A SEGUNDA CHANCE DO PRIMEIRO ACESSO.
 *
 * ─── O beco sem saída ───────────────────────────────────────────────────────
 *
 * `app/auth/confirm/route.ts:132-142` estabelece a SESSÃO e só depois tenta
 * provisionar. Se `ensureTenantForUser` levanta — banco fora do ar por um
 * segundo, `service_role` ainda não propagada, disco cheio —, a rota audita e
 * manda para `/login?error=provisionamento`. Mas a sessão já existe: a pessoa
 * está logada, sem organização, e daí em diante todo caminho fecha.
 *
 *   /login       → entra de novo → `signInWithPassword.ts:110` → /app/inbox
 *   /app/inbox   → "Você não tem nenhuma organização ativa. Aceite um convite
 *                  ou contate o admin."
 *   /onboarding  → `layout.tsx:15` sem org → redirect("/login")
 *
 * As duas saídas que a mensagem oferece não existem para quem instalou o
 * sistema: não há convite (ninguém convidou) e não há admin (ELE é o admin).
 * Num self-host, a conta bloqueada é a do dono, e o desbloqueio pedia SQL na
 * mão — numa instalação que a pessoa acabou de fazer para não precisar disso.
 *
 * ─── O que esta action pode e o que ela não pode ────────────────────────────
 *
 * Só o NOME vem do cliente, e passa por Zod. `organization_id`, papel e vínculo
 * nunca são aceitos de fora: quem os decide é `ensureTenantForUser`, o mesmo
 * caminho do signup. Quem já tem organização é redirecionado antes de qualquer
 * escrita — sem isso, a tela viraria "crie quantas empresas quiser".
 *
 * O convite é classificado ANTES do contador: quem foi convidado não abre
 * empresa própria (é a mesma bifurcação de `confirm/route.ts`), e chegar aqui
 * com convite pendente não pode gastar tentativa de quem realmente precisa.
 *
 * Achado de @prevprocesso-maker no PR #465.
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
