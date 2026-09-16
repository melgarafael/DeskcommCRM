"use server";

import { supportWriteError } from "@/lib/impersonate/support";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Salva PARA ONDE o Google Ads reporta — a conta e a ação de conversão.
 *
 * Irmã de `updateAdPlatformConnection.ts` (a da Meta), separada porque o
 * refresh token não entra aqui: ele chega pelo fluxo OAuth
 * (`/api/v1/plataformas-de-anuncio/google/connect` → `.../callback`), que é a
 * ÚNICA porta de escrita dele. Esta action só grava os três identificadores
 * que o OAuth não descobre sozinho — ver o cabeçalho da migration 0263 — e o
 * interruptor de habilitado, mesmo par admin+MFA da irmã.
 */
export type UpdateGoogleAdsConnectionResult =
  | { ok: true }
  | {
      ok: false;
      error:
        | "validation_failed"
        | "unauthenticated"
        | "forbidden_tenant"
        | "forbidden_role"
        | "mfa_required"
        | "erro_ao_gravar";
      details?: unknown;
    };

const entradaSchema = z.object({
  customer_id: z
    .string()
    .trim()
    .transform((v) => v.replace(/\D/g, ""))
    .pipe(z.string().length(10, "precisa ter 10 dígitos")),
  login_customer_id: z
    .string()
    .trim()
    .transform((v) => v.replace(/\D/g, ""))
    .pipe(z.union([z.literal(""), z.string().length(10)]))
    .nullable()
    .optional(),
  conversion_action_id: z.string().trim().min(1).max(32).regex(/^\d+$/, "só dígitos"),
  enabled: z.boolean(),
});

export type GoogleAdsConnectionInput = z.infer<typeof entradaSchema>;

export async function updateGoogleAdsConnection(
  input: GoogleAdsConnectionInput,
): Promise<UpdateGoogleAdsConnectionResult> {
  const parsed = entradaSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "validation_failed", details: parsed.error.flatten() };
  }

  const authUser = await loadAuthUser();
  if (!authUser) return { ok: false, error: "unauthenticated" };
  if (supportWriteError(authUser.support)) return { ok: false, error: "forbidden_role" };
  const activeOrg = await resolveActiveOrg(authUser);
  if (!activeOrg) return { ok: false, error: "forbidden_tenant" };
  if (!authUser.is_platform_admin && ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) {
    return { ok: false, error: "forbidden_role" };
  }
  if (await mfaEmDivida()) return { ok: false, error: "mfa_required" };

  const admin = createAdminClient();

  const loginCustomerId = parsed.data.login_customer_id?.trim() || null;

  // `update`, não `upsert`: a linha só existe depois do OAuth (a rota de
  // callback já fez o upsert com o refresh token). Chegar aqui sem linha é
  // tentar configurar uma conexão que nunca foi autorizada, e um `upsert`
  // criaria uma linha `enabled=true` sem refresh token nenhum — exatamente o
  // estado "conectada e não funciona" que a tela existe para não permitir.
  const { data, error } = await admin
    .from("ad_platform_connections")
    .update({
      google_customer_id: parsed.data.customer_id,
      google_login_customer_id: loginCustomerId,
      google_conversion_action_id: parsed.data.conversion_action_id,
      enabled: parsed.data.enabled,
      updated_by: authUser.id,
    })
    .eq("organization_id", activeOrg.orgId)
    .eq("platform", "google_ads")
    .select("id");

  if (error) return { ok: false, error: "erro_ao_gravar", details: error.message };
  // A CATRACA DA ISSUE #144: `update` sem `.select()` devolve sucesso mesmo
  // casando ZERO linhas. Sem conexão OAuth ainda, `data` vem vazio — e é
  // exatamente o caso "autorize o Google primeiro" que a tela precisa dizer.
  if (!data || data.length === 0) {
    return { ok: false, error: "erro_ao_gravar", details: "conecte com o Google primeiro" };
  }

  const hdrs = await headers();
  await audit({
    action: "ad_platform_connection.updated",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "ad_platform_connections",
    resourceId: null,
    requestId: hdrs.get("x-request-id") ?? undefined,
    ip: hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ?? undefined,
    userAgent: hdrs.get("user-agent") ?? undefined,
    metadata: {
      platform: "google_ads",
      enabled: parsed.data.enabled,
      customer_id: parsed.data.customer_id,
      tem_login_customer_id: Boolean(loginCustomerId),
    },
  });

  revalidatePath("/app/settings/conversoes");
  return { ok: true };
}
