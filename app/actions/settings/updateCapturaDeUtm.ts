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
 * Salva PARA ONDE o endereço de captura de UTM manda quem clicou no botão da
 * landing page — o número de WhatsApp e o texto pré-preenchido.
 *
 * Irmã de `updateGoogleAdsConnection.ts`, e com o MESMO par admin+MFA: a linha
 * decide para qual número o tráfego pago da organização é despejado, e trocá-la
 * sem querer manda os leads de quem anuncia para o WhatsApp errado.
 *
 * `upsert`, e não `update`: ao contrário da conexão do Google (que só existe
 * depois do OAuth), esta configuração NASCE nesta tela. Não há passo anterior.
 */
export type UpdateCapturaDeUtmResult =
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
  plataforma: z.enum(["meta_ads", "google_ads"]).default("meta_ads"),
  // E.164 COM `+`, o mesmo formato de `contacts.phone_number`. A tela oferece
  // os números já conectados, mas aceitar digitação é de propósito: o número da
  // landing page não precisa ser um canal do CRM.
  //
  // O `+` pode faltar (quem copia do WhatsApp cola sem ele), mas o CÓDIGO DO
  // PAÍS não: `11 99999-9999` tem ONZE dígitos e, com um `+` colado na frente,
  // vira `+1 1999999999` — um número dos Estados Unidos que existe e não é o da
  // pessoa. O tráfego pago iria para lá sem nada quebrar, então aqui isso é
  // recusa com motivo, não um chute.
  //
  // Por que o piso do `+` automático é 12 e não 11: nenhum número BRASILEIRO
  // local chega a 12 dígitos (DDD de 2 + 9 do celular = 11), então de 12 para
  // cima o que foi digitado só pode estar carregando código de país. Abaixo
  // disso a recusa pede o `+` explícito — inclusive para um `+1` americano de
  // 11 dígitos, que é o preço de não adivinhar país num campo que decide para
  // onde o tráfego pago é despejado.
  whatsapp_e164: z
    .string()
    .trim()
    .transform((v) => v.replace(/[^\d+]/g, ""))
    .transform((v) => (v.startsWith("+") || v.length < 12 ? v : `+${v}`))
    .pipe(z.string().regex(/^\+[1-9]\d{9,14}$/, "precisa ser um número com código do país")),
  // O `{token}` é o que o `check` da migration 0381 também cobra: sem ele o
  // ref não tem onde entrar, e a captura viraria um redirecionador mudo.
  message_template: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .refine((v) => v.includes("{token}"), "precisa conter {token}"),
  enabled: z.boolean(),
});

export type CapturaDeUtmInput = z.input<typeof entradaSchema>;

export async function updateCapturaDeUtm(
  input: CapturaDeUtmInput,
): Promise<UpdateCapturaDeUtmResult> {
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

  const tabela =
    parsed.data.plataforma === "google_ads" ? "google_ads_landing_pages" : "meta_ads_landing_pages";
  const valores = {
    organization_id: activeOrg.orgId,
    whatsapp_e164: parsed.data.whatsapp_e164,
    message_template: parsed.data.message_template,
    enabled: parsed.data.enabled,
    updated_by: authUser.id,
  };
  // Tabelas literais permitem conferir cada alvo de conflito contra o schema real.
  const { error } =
    tabela === "google_ads_landing_pages"
      ? await admin.from("google_ads_landing_pages").upsert(valores, { onConflict: "organization_id" })
      : await admin.from("meta_ads_landing_pages").upsert(valores, { onConflict: "organization_id" });

  if (error) return { ok: false, error: "erro_ao_gravar", details: error.message };

  const hdrs = await headers();
  await audit({
    action: "captura_de_utm.updated",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: tabela,
    resourceId: null,
    requestId: hdrs.get("x-request-id") ?? undefined,
    ip: hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ?? undefined,
    userAgent: hdrs.get("user-agent") ?? undefined,
    // O número vai no registro porque é ele que decide para onde o tráfego
    // pago é mandado — quem trocou, e para qual, é a pergunta de auditoria.
    metadata: {
      plataforma: parsed.data.plataforma,
      enabled: parsed.data.enabled,
      whatsapp_e164: parsed.data.whatsapp_e164,
    },
  });

  revalidatePath("/app/settings/conversoes");
  return { ok: true };
}
