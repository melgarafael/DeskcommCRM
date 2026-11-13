/**
 * Conexão do canal de SMS (#4415).
 *
 * GET  → o estado da conexão da organização (sem segredo nenhum na resposta).
 * POST → conecta: confere na conta do fornecedor que a chave vale e que o
 *        número é dela, grava a conexão e aponta o recebimento do número para a
 *        URL deste CRM. O registro de remetente dos EUA (A2P 10DLC) é feito no
 *        fornecedor ANTES — o número chega pronto.
 *
 * Só `admin` conecta canal, como nos demais. A organização sai da sessão
 * (`requireRole`), nunca do corpo.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import {
  acharNumeroNaConta,
  acharSessaoDeSms,
  apontarRecebimentoDoNumero,
  ROTULO_DO_CANAL_SMS,
  salvarSessaoDeSms,
} from "@/lib/channels/sms";
import { traduzirLimiteDoPlano } from "@/lib/cobranca/limites";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";
import { basePublicaDaInstalacao } from "@/lib/webhooks/url-publica";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const conectarSchema = z.object({
  account_sid: z.string().trim().regex(/^AC[0-9a-f]{32}$/i),
  auth_token: z.string().trim().min(16).max(200),
  phone_number: z.string().trim().regex(/^\+[1-9]\d{7,14}$/),
});

function urlDeRecebimento(req: NextRequest, token: string): string {
  return `${basePublicaDaInstalacao(req)}/api/v1/webhooks/channel/${token}`;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "channels_sms" });
  if (!authz.ok) return authz.response;

  const sessao = await acharSessaoDeSms(createAdminClient(), authz.org.orgId);
  const ativa = sessao && !sessao.archivedAt ? sessao : null;
  return ok(
    {
      label: ROTULO_DO_CANAL_SMS,
      connected: Boolean(ativa),
      channel_session_id: ativa?.id ?? null,
      phone_number: ativa?.numero ?? null,
      display_name: ativa?.displayName ?? null,
      status: ativa?.status ?? null,
      webhook_url: ativa?.webhookPathToken ? urlDeRecebimento(req, ativa.webhookPathToken) : null,
    },
    { requestId },
  );
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "channels_sms" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;

  const parsed = conectarSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail(
      "invalid_request",
      t("Confira os três campos: o Account SID (começa com AC), o Auth Token e o número no formato +1…"),
      422,
      { requestId },
    );
  }
  const creds = { accountSid: parsed.data.account_sid, authToken: parsed.data.auth_token };

  const achado = await acharNumeroNaConta(creds, parsed.data.phone_number);
  if (!achado.ok) {
    const mensagem =
      achado.motivo === "credencial"
        ? t("A conta de SMS recusou o Account SID ou o Auth Token. Copie os dois de novo do painel.")
        : achado.motivo === "numero_fora_da_conta"
          ? t("Este número não está nesta conta de SMS. Confira o número ou a conta.")
          : t("Não foi possível falar com a conta de SMS agora. Tente de novo em instantes.");
    return fail("invalid_request", mensagem, 422, { requestId });
  }

  const admin = createAdminClient();
  const chaveCifrada = await encryptWebhookSecret(admin, creds.authToken);
  if (!chaveCifrada) {
    return fail("invalid_request", t("cifra indisponível nesta instalação — a chave não foi gravada"), 422, {
      requestId,
    });
  }

  const existente = await acharSessaoDeSms(admin, orgId);
  const displayName = existente?.displayName || achado.nome || `${ROTULO_DO_CANAL_SMS} ${achado.numero}`;
  const salvo = await salvarSessaoDeSms(admin, {
    organizationId: orgId,
    existente,
    numeroId: achado.numeroId,
    contaId: creds.accountSid,
    numero: achado.numero,
    chaveCifrada,
    displayName,
    userId: authz.user.id,
    requestId,
  });
  if (salvo.error) {
    const limite = traduzirLimiteDoPlano(salvo.error, authz.user.idioma);
    if (limite) return fail(limite.code, limite.message, 409, { requestId, details: limite.details });
    return fail("internal_error", salvo.error, 500, { requestId });
  }

  // O recebimento: apontar o número para cá. Falhar aqui não desfaz a
  // conexão — o envio já funciona —, mas a tela precisa dizer, com a URL para
  // colar à mão (número dentro de um Messaging Service recebe pelo serviço).
  const webhookUrl = salvo.webhookPathToken ? urlDeRecebimento(req, salvo.webhookPathToken) : null;
  const apontado = webhookUrl
    ? await apontarRecebimentoDoNumero(creds, achado.numeroId, webhookUrl)
    : { ok: false as const, detalhe: "sem token de recebimento" };
  if (!apontado.ok) {
    logger.warn("[sms] conexão gravada, mas o recebimento do número não foi apontado", {
      organization_id: orgId,
      channel_session_id: salvo.channelSessionId,
      detail: apontado.detalhe.slice(0, 160),
      request_id: requestId,
    });
  }

  void audit({
    action: "channel.connected",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "channel_session",
    resourceId: salvo.channelSessionId,
    requestId,
    metadata: { canal: "sms", phone_number: achado.numero, recebimento_apontado: apontado.ok },
  });

  return ok(
    {
      connected: true,
      phone_number: achado.numero,
      display_name: displayName,
      webhook_url: webhookUrl,
      receiving_configured: apontado.ok,
    },
    { requestId },
  );
}
