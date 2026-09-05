"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";

/**
 * Conectar a conta de anúncios para LER as métricas — pela tela.
 *
 * Irmã de `updateAdPlatformConnection.ts`, que faz o mesmo para o eixo de
 * conversões, e separada dela pelas razões no cabeçalho da migration 0214 (a
 * decisiva: o índice único da 0213 é `(organization_id, platform)` e os dois
 * tokens têm escopos diferentes na plataforma).
 *
 * ─── O que isto fecha (invariante 6 da doutrina de restrição de canal) ──────
 *
 * "Nenhum mecanismo de backend pode depender de estado configurável que não
 * tenha tela para ver, tela para mudar, e caminho visível de falha." As rotas
 * `/api/v1/ads/meta/*` nasceriam violando isso: sem esta ação, a credencial
 * delas só existiria para quem sabe dar INSERT numa tabela.
 *
 * ─── Por que `admin` da ORGANIZAÇÃO ─────────────────────────────────────────
 *
 * Mesmo gate de `updateAdPlatformConnection.ts`, e pelo mesmo motivo: o objeto é
 * a conta de anúncios de um negócio. Numa agência que hospeda dois clientes na
 * mesma VPS, cada um tem a sua, e exigir platform admin faria o dono do próprio
 * tráfego depender de quem hospeda para uma decisão que é dele.
 *
 * O papel é `admin` mesmo o token sendo SÓ DE LEITURA. Ele expõe orçamento,
 * criativo e performance de toda a conta — dado que um concorrente pagaria para
 * ver —, e quem pode LER a tela (`manager`) não precisa poder trocar a
 * credencial que a alimenta.
 *
 * ─── NUNCA em claro ─────────────────────────────────────────────────────────
 *
 * Se `fn_encrypt_oauth` não puder cifrar, o save RECUSA. Cair para texto puro
 * trocaria "não dá para configurar" por "está configurado e desprotegido", e o
 * segundo não tem sintoma. Mesma decisão de `updateGoogleOAuth.ts`,
 * `updateAdPlatformConnection.ts` e `channels/official/route.ts`.
 */
export type UpdateAdInsightsConnectionResult =
  | { ok: true }
  | {
      ok: false;
      error:
        | "validation_failed"
        | "unauthenticated"
        | "forbidden_tenant"
        | "forbidden_role"
        | "mfa_required"
        | "cifra_indisponivel"
        | "erro_ao_gravar";
      details?: unknown;
    };

const entradaSchema = z.object({
  /**
   * Só `meta_ads` hoje. `google_ads` fica FORA do enum pela mesma razão da
   * 0204: aceitar o cadastro de uma plataforma sem leitor deixaria o operador
   * colar um token e esperar uma tabela que nunca carregaria.
   */
  platform: z.literal("meta_ads"),
  /**
   * OPCIONAL: permite trocar a conta padrão sem redigitar o token, que a tela
   * nunca mostra de volta. Vazio = "mantenha o que está gravado", NUNCA
   * "apague" — mesma regra da 0213, pelo mesmo motivo (um salvamento distraído
   * não pode derrubar o que já funcionava).
   *
   * Na PRIMEIRA conexão ele é obrigatório, e quem garante isso é o handler
   * abaixo: sem linha gravada, não há o que manter.
   */
  access_token: z.string().trim().min(20).max(1000).optional(),
  default_account_id: z
    .string()
    .trim()
    .regex(/^act_\d+$/, "conta no formato act_<id>")
    .nullable()
    .optional(),
});

export type AdInsightsConnectionInput = z.infer<typeof entradaSchema>;

export async function updateAdInsightsConnection(
  input: AdInsightsConnectionInput,
): Promise<UpdateAdInsightsConnectionResult> {
  const parsed = entradaSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "validation_failed", details: parsed.error.flatten() };
  }

  const authUser = await loadAuthUser();
  if (!authUser) return { ok: false, error: "unauthenticated" };
  const activeOrg = await resolveActiveOrg(authUser);
  if (!activeOrg) return { ok: false, error: "forbidden_tenant" };
  if (!authUser.is_platform_admin && ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) {
    return { ok: false, error: "forbidden_role" };
  }
  // Depois do papel, pelo mesmo motivo de `updateAdPlatformConnection.ts`: quem
  // nem tem o papel recebe a verdade sobre ele, não uma cobrança de segundo fator.
  if (await mfaEmDivida()) return { ok: false, error: "mfa_required" };

  const admin = createAdminClient();

  const { data: existente, error: erroDeLeitura } = await admin
    .from("ad_insights_connections")
    .select("id")
    .eq("organization_id", activeOrg.orgId)
    .eq("platform", parsed.data.platform)
    .maybeSingle();

  if (erroDeLeitura) {
    return { ok: false, error: "erro_ao_gravar", details: erroDeLeitura.message };
  }

  // Primeira conexão SEM token é `validation_failed`, não `erro_ao_gravar`: a
  // coluna é NOT NULL (0214) e o banco recusaria de qualquer jeito, mas com uma
  // mensagem de constraint que não diz a quem lê a tela o que fazer. O erro
  // certo é "o token é obrigatório da primeira vez".
  if (!existente && !parsed.data.access_token) {
    return {
      ok: false,
      error: "validation_failed",
      details: { access_token: ["obrigatório na primeira conexão"] },
    };
  }

  const valores: Record<string, unknown> = {
    organization_id: activeOrg.orgId,
    platform: parsed.data.platform,
    updated_by: authUser.id,
  };

  // `undefined` = não mexer; `null` = limpar a escolha de conta padrão. Os dois
  // são pedidos diferentes e o schema os distingue (`.nullable().optional()`).
  if (parsed.data.default_account_id !== undefined) {
    valores.default_account_id = parsed.data.default_account_id;
  }

  if (parsed.data.access_token) {
    const cifrado = await encryptWebhookSecret(admin, parsed.data.access_token);
    if (!cifrado) return { ok: false, error: "cifra_indisponivel" };
    valores.access_token_encrypted = cifrado;
  }

  // `upsert` e não `update`: a linha não existe em quem nunca conectou, e um
  // `update` casaria zero linhas devolvendo SUCESSO — a tela diria "salvo" e
  // nada seria gravado. Mesmo modo de falha que a #144 mediu em `organizations`.
  // O `onConflict` é o índice único `(organization_id, platform)` da 0214.
  const { error } = await admin
    .from("ad_insights_connections")
    .upsert(valores, { onConflict: "organization_id,platform" });

  if (error) return { ok: false, error: "erro_ao_gravar", details: error.message };

  const hdrs = await headers();
  await audit({
    action: "ad_insights_connection.updated",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "ad_insights_connections",
    resourceId: null,
    requestId: hdrs.get("x-request-id") ?? undefined,
    ip: hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ?? undefined,
    userAgent: hdrs.get("user-agent") ?? undefined,
    metadata: {
      platform: parsed.data.platform,
      // O QUE mudou, jamais o valor. O id da conta pode ir (é identificador,
      // não segredo); o token não entra nem em metadata.
      default_account_id: parsed.data.default_account_id ?? null,
      token_trocado: Boolean(parsed.data.access_token),
      primeira_conexao: !existente,
    },
  });

  revalidatePath("/app/settings/meta-ads");
  revalidatePath("/app/ads/meta");
  return { ok: true };
}

/**
 * Desconectar — apagar a linha.
 *
 * Não existe "pausar" nesta feature (a 0205 não tem `enabled`, e o porquê está
 * no cabeçalho dela): como nada roda sozinho, um estado "conectado mas
 * desligado" teria a mesma consequência visível de não estar conectado. Então
 * desconectar é apagar, e reconectar é colar o token de novo — o mesmo trabalho
 * que religar daria.
 */
export async function disconnectAdInsights(): Promise<UpdateAdInsightsConnectionResult> {
  const authUser = await loadAuthUser();
  if (!authUser) return { ok: false, error: "unauthenticated" };
  const activeOrg = await resolveActiveOrg(authUser);
  if (!activeOrg) return { ok: false, error: "forbidden_tenant" };
  if (!authUser.is_platform_admin && ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) {
    return { ok: false, error: "forbidden_role" };
  }
  if (await mfaEmDivida()) return { ok: false, error: "mfa_required" };

  const admin = createAdminClient();
  const { error } = await admin
    .from("ad_insights_connections")
    .delete()
    .eq("organization_id", activeOrg.orgId)
    .eq("platform", "meta_ads");

  if (error) return { ok: false, error: "erro_ao_gravar", details: error.message };

  const hdrs = await headers();
  await audit({
    action: "ad_insights_connection.deleted",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "ad_insights_connections",
    resourceId: null,
    requestId: hdrs.get("x-request-id") ?? undefined,
    ip: hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ?? undefined,
    userAgent: hdrs.get("user-agent") ?? undefined,
    metadata: { platform: "meta_ads" },
  });

  revalidatePath("/app/settings/meta-ads");
  revalidatePath("/app/ads/meta");
  return { ok: true };
}
