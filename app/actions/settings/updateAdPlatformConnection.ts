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
 * Conectar a conta de anúncios para receber as vendas de volta — pela tela.
 *
 * ─── O que isto fecha (invariante 6 da doutrina de restrição de canal) ──────
 *
 * "Nenhum mecanismo de backend pode depender de estado configurável que não
 * tenha tela para ver, tela para mudar, e caminho visível de falha." O handler
 * de conversões nasceria violando isso: sem esta tela ele seria operável só por
 * quem sabe dar UPDATE numa tabela, que é o mesmo que não existir — a lição
 * cara da #144, onde rodízio e visibilidade existiam INTEIROS e um contribuidor
 * abriu issue pedindo a feature que já estava construída.
 *
 * ─── Por que admin da ORGANIZAÇÃO, e não platform admin ─────────────────────
 *
 * O oposto de `updateGoogleOAuth.ts`, e de propósito. Lá o objeto é a
 * INSTALAÇÃO (o `redirect_uri` sai do `NEXT_PUBLIC_APP_URL`). Aqui o objeto é a
 * CONTA DE ANÚNCIOS de um negócio: numa agência que hospeda dois clientes, cada
 * um tem o seu dataset, e exigir platform admin faria o dono do próprio tráfego
 * depender de quem hospeda para uma decisão que é dele.
 *
 * ─── NUNCA em claro ─────────────────────────────────────────────────────────
 *
 * Se `fn_encrypt_oauth` não puder cifrar, o save RECUSA. Cair para texto puro
 * trocaria "não dá para configurar" por "está configurado e desprotegido", e o
 * segundo não tem sintoma. Mesma decisão de `updateGoogleOAuth.ts` e de
 * `app/api/v1/channels/official/route.ts`.
 *
 * O token escreve na conta de anúncios do cliente: vazá-lo deixa terceiro
 * injetar conversão falsa e envenenar o otimizador de quem paga a mídia.
 */
export type UpdateAdPlatformConnectionResult =
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
   * Só `meta_ads` hoje. `google_ads` fica FORA do enum de propósito: aceitar o
   * cadastro de uma plataforma sem transporte deixaria o operador colar um token
   * e esperar conversões que nunca sairiam — e o livro-razão diria
   * `plataforma_sem_transporte` sem que ele tivesse como entender por quê.
   */
  platform: z.literal("meta_ads"),
  dataset_id: z.string().trim().min(5).max(64).regex(/^\d+$/, "só dígitos"),
  /**
   * OPCIONAL: permite corrigir o dataset sem redigitar o token, que a tela nunca
   * mostra de volta. Vazio = "mantenha o que está gravado", NUNCA "apague" — um
   * salvamento distraído não pode derrubar o reporte de vendas.
   *
   * Para PARAR de enviar existe o switch `enabled`, que pausa e preserva a
   * credencial. Remover a conexão de vez ainda não tem caminho pela tela (ver a
   * lacuna anotada em `app/app/settings/conversoes/_form.tsx`).
   */
  access_token: z.string().trim().min(20).max(1000).optional(),
  /** Enquanto preenchido, os eventos vão como teste e não contam. */
  test_event_code: z.string().trim().max(64).nullable().optional(),
  enabled: z.boolean(),
});

export type AdPlatformConnectionInput = z.infer<typeof entradaSchema>;

export async function updateAdPlatformConnection(
  input: AdPlatformConnectionInput,
): Promise<UpdateAdPlatformConnectionResult> {
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
  // Depois do papel, pelo mesmo motivo de `updateMarcaDaOrganizacao.ts`: quem
  // nem tem o papel recebe a verdade sobre ele, não uma cobrança de segundo fator.
  if (await mfaEmDivida()) return { ok: false, error: "mfa_required" };

  const admin = createAdminClient();

  const valores: Record<string, unknown> = {
    organization_id: activeOrg.orgId,
    platform: parsed.data.platform,
    dataset_id: parsed.data.dataset_id,
    test_event_code: parsed.data.test_event_code?.trim() || null,
    enabled: parsed.data.enabled,
    updated_by: authUser.id,
  };

  if (parsed.data.access_token) {
    const cifrado = await encryptWebhookSecret(admin, parsed.data.access_token);
    if (!cifrado) return { ok: false, error: "cifra_indisponivel" };
    valores.access_token_encrypted = cifrado;
  }

  // `upsert` e não `update`: a linha não existe em quem nunca conectou, e um
  // `update` casaria zero linhas devolvendo SUCESSO — a tela diria "salvo" e nada
  // seria gravado. É o modo de falha que a #144 mediu em `organizations`, e a
  // defesa é não escrever a query que o permite. O `onConflict` é o índice único
  // `(organization_id, platform)` da 0204.
  const { error } = await admin
    .from("ad_platform_connections")
    .upsert(valores, { onConflict: "organization_id,platform" });

  if (error) return { ok: false, error: "erro_ao_gravar", details: error.message };

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
      platform: parsed.data.platform,
      enabled: parsed.data.enabled,
      // O QUE mudou, jamais o valor. O dataset id pode ir (é identificador, não
      // segredo); o token não entra nem em metadata.
      dataset_id: parsed.data.dataset_id,
      token_trocado: Boolean(parsed.data.access_token),
      em_teste: Boolean(parsed.data.test_event_code?.trim()),
    },
  });

  revalidatePath("/app/settings/conversoes");
  return { ok: true };
}
