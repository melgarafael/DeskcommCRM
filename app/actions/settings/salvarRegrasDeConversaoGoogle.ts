"use server";

/**
 * Grava as regras de conversão do Google Ads por etapa (migration 0436).
 *
 * A tela manda a lista INTEIRA das etapas abertas, cada uma ligada ou não.
 * Regra que some da lista é DESLIGADA, nunca apagada: a linha guarda o
 * `event_name` que o livro-razão já usa para aquela etapa, e apagar faria uma
 * religação futura nascer com outro nome — e reenviar negócios que já foram.
 *
 * O `event_name` de uma etapa nasce uma vez (`Etapa:<uuid>`) e não muda; a
 * qualificação migrada da 0402 mantém `QualifiedLead`.
 */
import { supportWriteError } from "@/lib/impersonate/support";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK, escreveComoPlatformAdmin } from "@/lib/auth/types";
import { createAdminClient } from "@/lib/supabase/admin";
import { eventoDaEtapa, VALORES_DE_CATEGORIA } from "@/lib/conversoes/regras-google";

export type SalvarRegrasResult =
  | { ok: true }
  | {
      ok: false;
      error:
        | "validation_failed"
        | "unauthenticated"
        | "forbidden_tenant"
        | "forbidden_role"
        | "mfa_required"
        | "etapa_invalida"
        | "erro_ao_gravar";
      details?: unknown;
    };

const regraSchema = z
  .object({
    stage_id: z.uuid(),
    enabled: z.boolean(),
    label: z.string().trim().max(100),
    google_action_id: z.string().trim().max(32).regex(/^\d*$/, "só dígitos"),
    category: z.enum(VALORES_DE_CATEGORIA),
    included_in_conversions: z.boolean(),
    channel: z.enum(["todos", "whatsapp", "outros"]),
  })
  .refine((r) => !r.enabled || (r.label.length > 0 && r.google_action_id.length > 0), {
    message: "Regra ligada precisa de nome e de ação de conversão.",
  });

const entradaSchema = z
  .array(regraSchema)
  .max(200)
  .refine((lista) => new Set(lista.map((r) => r.stage_id)).size === lista.length, {
    message: "Etapa repetida.",
  });

export type RegraDeConversaoInput = z.input<typeof regraSchema>;

export async function salvarRegrasDeConversaoGoogle(
  input: RegraDeConversaoInput[],
): Promise<SalvarRegrasResult> {
  const parsed = entradaSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "validation_failed", details: parsed.error.flatten() };
  }

  const authUser = await loadAuthUser();
  if (!authUser) return { ok: false, error: "unauthenticated" };
  if (supportWriteError(authUser.support)) return { ok: false, error: "forbidden_role" };
  const activeOrg = await resolveActiveOrg(authUser);
  if (!activeOrg) return { ok: false, error: "forbidden_tenant" };
  if (
    !(escreveComoPlatformAdmin(authUser) && !authUser.support) &&
    ROLE_RANK[activeOrg.role] < ROLE_RANK.admin
  ) {
    return { ok: false, error: "forbidden_role" };
  }
  if (await mfaEmDivida()) return { ok: false, error: "mfa_required" };

  const admin = createAdminClient();
  const orgId = activeOrg.orgId;
  const regras = parsed.data;

  // Toda etapa ligada precisa ser DESTA organização e estar aberta: ganho é a
  // compra (outro consumidor) e perda não é conversão.
  const ligadas = regras.filter((r) => r.enabled).map((r) => r.stage_id);
  if (ligadas.length > 0) {
    const { data: etapas, error } = await admin
      .from("crm_stages")
      .select("id")
      .eq("organization_id", orgId)
      .eq("is_won", false)
      .eq("is_lost", false)
      .in("id", ligadas);
    if (error) return { ok: false, error: "erro_ao_gravar" };
    const validas = new Set(((etapas ?? []) as Array<{ id: string }>).map((e) => e.id));
    if (ligadas.some((id) => !validas.has(id))) return { ok: false, error: "etapa_invalida" };
  }

  const { data: existentes, error: erroLeitura } = await admin
    .from("google_ads_conversion_rules")
    .select("stage_id, event_name, label, google_action_id")
    .eq("organization_id", orgId);
  if (erroLeitura) return { ok: false, error: "erro_ao_gravar" };
  type Existente = {
    stage_id: string;
    event_name: string;
    label: string;
    google_action_id: string;
  };
  const existentePorEtapa = new Map(
    ((existentes ?? []) as Existente[]).map((r) => [r.stage_id, r]),
  );

  // Regra desligada que nunca existiu não vira linha: não há nome a preservar.
  const linhas = regras
    .filter((r) => r.enabled || existentePorEtapa.has(r.stage_id))
    .map((r) => {
      // Desligada com campos vazios preserva o que já estava gravado: as
      // colunas são NOT NULL, e todas as linhas do upsert levam as mesmas.
      const antes = existentePorEtapa.get(r.stage_id);
      return {
        organization_id: orgId,
        stage_id: r.stage_id,
        event_name: antes?.event_name ?? eventoDaEtapa(r.stage_id),
        label: r.label || antes?.label || "Etapa do funil",
        google_action_id: r.google_action_id || antes?.google_action_id || "0",
        category: r.category,
        included_in_conversions: r.included_in_conversions,
        channel: r.channel,
        enabled: r.enabled,
        updated_by: authUser.id,
      };
    });

  if (linhas.length > 0) {
    const { error } = await admin
      .from("google_ads_conversion_rules")
      .upsert(linhas, { onConflict: "organization_id,stage_id" });
    if (error) return { ok: false, error: "erro_ao_gravar", details: error.message };
  }

  // O que sumiu da lista é desligado — nunca apagado (ver o cabeçalho).
  const enviadas = new Set(regras.map((r) => r.stage_id));
  const sumidas = [...existentePorEtapa.keys()].filter((id) => !enviadas.has(id));
  if (sumidas.length > 0) {
    const { error } = await admin
      .from("google_ads_conversion_rules")
      .update({ enabled: false, updated_by: authUser.id })
      .eq("organization_id", orgId)
      .in("stage_id", sumidas);
    if (error) return { ok: false, error: "erro_ao_gravar", details: error.message };
  }

  const hdrs = await headers();
  await audit({
    action: "google_ads_conversion_rules.updated",
    actorUserId: authUser.id,
    organizationId: orgId,
    resourceType: "google_ads_conversion_rules",
    resourceId: null,
    requestId: hdrs.get("x-request-id") ?? undefined,
    ip: hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ?? undefined,
    userAgent: hdrs.get("user-agent") ?? undefined,
    metadata: {
      ligadas: ligadas.length,
      desligadas: regras.length - ligadas.length + sumidas.length,
    },
  });

  revalidatePath("/app/settings/conversoes");
  return { ok: true };
}
