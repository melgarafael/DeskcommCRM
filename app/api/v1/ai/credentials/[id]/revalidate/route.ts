import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/ai/credentials/:id/revalidate (admin)
 *
 * Decifra a credential, faz ping síncrono ao provider e atualiza
 * `validated_at` / `validation_error` / `models_available`. Diferente do POST
 * de criação, aqui esperamos o resultado pra devolver ao usuário (botão "Test").
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { byteaToBuffer, decryptKey } from "@/lib/crypto/aes_gcm";
import { validateProviderKey } from "@/lib/ai/provider-validators";
import { lerBaseUrlDaCredencial } from "@/lib/ai/credenciais/guardar";
import { renovarComTravaDeBanco } from "@/lib/ai/credenciais/login-codex";
import { renovarPorRefreshToken } from "@/lib/ai/pontos/pkce-da-assinatura";
import { PROVEDOR_POR_ASSINATURA } from "@/lib/ai/pontos/provedores";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const SAFE_COLUMNS =
  "id, organization_id, provider, label, api_key_last4, validated_at, validation_error, models_available, is_active, created_by, created_at, updated_at";

export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await requireRole("admin", { requestId, resource: "ai_credentials" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user: authUser, org: activeOrg } = authz;

  const admin = createAdminClient();

  // Pra revalidate ignoramos o gate `validated_at` do loadCredential — fazemos
  // a leitura bruta e decifragem direta.
  const { data: row, error: fetchErr } = await admin
    .from("ai_provider_credentials")
    .select(
      "id, organization_id, provider, label, api_key_encrypted, api_key_iv, api_key_tag, is_active",
    )
    .eq("id", id)
    .maybeSingle();

  if (fetchErr) {
    return fail("internal_error", "Erro ao consultar credential.", 500, { requestId });
  }
  if (!row || row.organization_id !== activeOrg.orgId) {
    return fail("not_found", t("Credential não encontrada."), 404, { requestId });
  }
  if (!row.is_active) {
    return fail("credential_inactive", t("Credential desativada."), 409, { requestId });
  }

  // O RAMO DO LOGIN POR ASSINATURA (#1672, item 3): não existe endpoint de
  // CHAVE para pingar — a única prova que este provider aceita é o refresh
  // aceito. A renovação passa pela TRAVA DO BANCO (nenhum outro processo pode
  // rodar o POST ao mesmo tempo) e regrava o par na MESMA linha, com
  // `validated_at` renovado.
  if (row.provider === PROVEDOR_POR_ASSINATURA) {
    const renovado = await renovarComTravaDeBanco({
      admin,
      orgId: activeOrg.orgId,
      credentialId: id,
      userId: authUser.id,
      renovar: (atuais) => renovarPorRefreshToken({ refreshToken: atuais.refresh_token }),
    });
    if (renovado.ok) {
      const { data: safe } = await admin
        .from("ai_provider_credentials_safe")
        .select(SAFE_COLUMNS)
        .eq("id", id)
        .single();
      await audit({
        action: "ai.credential_revalidated",
        actorUserId: authUser.id,
        organizationId: activeOrg.orgId,
        resourceType: "ai_provider_credential",
        resourceId: id,
        requestId,
        metadata: { provider: row.provider, label: row.label, ok: true, error: null },
      });
      return ok(safe, { requestId });
    }
    if (renovado.motivo === "em_curso" || renovado.motivo === "modulo_desligado") {
      return fail(
        "revalidate_in_progress",
        t(
          "Outra renovação desta conta está em curso (ou o recurso está desligado). Aguarde alguns segundos e tente de novo.",
        ),
        409,
        { requestId },
      );
    }
    return fail(
      "revalidate_failed",
      t("A OpenAI recusou a renovação do login. Gere o link de novo e conecte a conta outra vez."),
      409,
      { requestId },
    );
  }

  // Leitura direta + decifragem (sem passar pelo gate `validated_at` do
  // loadCredential — revalidate aceita credenciais ainda não validadas).
  let apiKey: string;
  try {
    apiKey = decryptKey({
      ciphertext: byteaToBuffer(row.api_key_encrypted),
      iv: byteaToBuffer(row.api_key_iv),
      tag: byteaToBuffer(row.api_key_tag),
    });
  } catch (err) {
    logger.error("[ai.credentials] decifragem falhou durante a revalidação", {
      credentialId: id,
      erro: err instanceof Error ? err.name : typeof err,
    });
    return fail("decrypt_failed", t("Falha ao decifrar credential."), 500, { requestId });
  }

  // O provedor personalizado (#1642) valida pelo endereço GRAVADO na linha —
  // sem ele, revalidar marcaria como inválida a credencial que funciona.
  const baseUrl =
    row.provider === "custom" ? await lerBaseUrlDaCredencial(admin, row.id) : undefined;
  const result = await validateProviderKey(row.provider, apiKey, baseUrl);
  const patch = result.ok
    ? {
        validated_at: new Date().toISOString(),
        validation_error: null,
        models_available: result.models,
      }
    : {
        validated_at: null,
        validation_error: result.error,
        // Não conservar o catálogo de uma validação anterior: a credencial
        // deixou de ser confiável e a lista antiga faria a tela parecer pronta.
        models_available: null,
      };

  const { data: updated, error: updErr } = await admin
    .from("ai_provider_credentials")
    .update(patch)
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .select(SAFE_COLUMNS)
    .single();

  if (updErr || !updated) {
    return fail("internal_error", "Erro ao atualizar credential.", 500, { requestId });
  }

  await audit({
    action: "ai.credential_revalidated",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "ai_provider_credential",
    resourceId: id,
    requestId,
    metadata: {
      provider: row.provider,
      label: row.label,
      ok: result.ok,
      error: result.ok ? null : result.error,
    },
  });

  return ok(updated, { requestId });
}
