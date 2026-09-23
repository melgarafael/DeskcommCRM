"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { ensureTenantForUser } from "@/lib/auth/provision";
import { createAdminClient } from "@/lib/supabase/admin";

const entradaSchema = z.object({
  requestId: z.string().uuid(),
  decision: z.enum(["approve", "reject"]),
});

export type DecideRegistrationResult =
  | { ok: true }
  | { ok: false; error: "invalid_input" | "not_found" | "account_unavailable" | "write_failed" };

/**
 * O administrador da INSTALAÇÃO aprova ou recusa um pedido de empresa nova
 * (modo `com_aprovacao`, migration 0383). Desenho de @betoarts, PR #714.
 *
 * Aprovar é o único ponto em que a empresa nasce, e ela nasce pelo MESMO
 * caminho do cadastro aberto (`ensureTenantForUser`): nome do pedido, a pessoa
 * como `admin` dela. Nada de organização, papel ou vínculo vem do cliente —
 * a entrada é só o id do pedido e a decisão.
 *
 * O gate é `is_platform_admin`, não `admin` de tenant: o pedido é anterior a
 * qualquer organização, e quem decide quem entra na instalação é quem a
 * administra. Mesma régua de `updateSignupMode.ts`.
 */
export async function decideRegistrationRequest(
  input: z.input<typeof entradaSchema>,
): Promise<DecideRegistrationResult> {
  const { user } = await requirePlatformAdmin();

  const parsed = entradaSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid_input" };

  const admin = createAdminClient();
  const { data: pedido, error } = await admin
    .from("registration_requests")
    .select("id, user_id, requested_organization_name")
    .eq("id", parsed.data.requestId)
    .eq("status", "pending")
    .maybeSingle();
  if (error || !pedido) return { ok: false, error: "not_found" };

  const aprovar = parsed.data.decision === "approve";
  let organizationId: string | null = null;

  if (aprovar) {
    const { data: conta } = await admin.auth.admin.getUserById(pedido.user_id);
    // Sem confirmação feita pelo provedor de auth, o endereço não foi provado —
    // e aprovar entregaria uma empresa a quem digitou o e-mail de outra pessoa.
    // Este módulo nunca confirma e-mail; só confere o que o provedor já fez.
    if (!conta.user || !conta.user.email_confirmed_at) {
      return { ok: false, error: "account_unavailable" };
    }
    try {
      const provisionado = await ensureTenantForUser(
        {
          id: conta.user.id,
          email: conta.user.email,
          user_metadata: { org_name: pedido.requested_organization_name },
        },
        { source: "signup" },
      );
      organizationId = provisionado.organizationId ?? null;
    } catch {
      return { ok: false, error: "write_failed" };
    }
  }

  // `.eq("status", "pending")` de novo: dois administradores decidindo o mesmo
  // pedido ao mesmo tempo, só o primeiro grava.
  const { error: gravacao } = await admin
    .from("registration_requests")
    .update({
      status: aprovar ? "approved" : "rejected",
      decided_by: user.id,
      decided_at: new Date().toISOString(),
    })
    .eq("id", pedido.id)
    .eq("status", "pending");
  if (gravacao) return { ok: false, error: "write_failed" };

  const hdrs = await headers();
  await audit({
    action: aprovar ? "registration.approved" : "registration.rejected",
    actorUserId: user.id,
    organizationId,
    resourceType: "registration_request",
    resourceId: pedido.id,
    actingAsPlatformAdmin: true,
    requestId: hdrs.get("x-request-id"),
    ip: hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: hdrs.get("user-agent"),
  });

  revalidatePath("/admin/cadastro");
  return { ok: true };
}
