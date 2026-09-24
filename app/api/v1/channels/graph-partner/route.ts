import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET   /api/v1/channels/graph-partner — estado da conexão + o que colar no provedor.
 * POST  /api/v1/channels/graph-partner — VALIDA o token e só então grava.
 * PATCH /api/v1/channels/graph-partner — grava o segredo de assinatura do webhook.
 *
 * O canal parceiro que espelha a Cloud API — recorte do PR #1130, de @vgamkt.
 * O caminho e o corpo não citam o provider: quem é, como se chamam as colunas e
 * como se valida o token estão em `lib/channels/graph-parceiro/` (`lint:channels`).
 *
 * ─── Desligado por padrão ───────────────────────────────────────────────────
 *
 * Canal opcional da INSTALAÇÃO (decisão do dono, doc 54, opção b). Com o
 * interruptor desligado as três respondem 404 antes de qualquer outra coisa:
 * quem não ligou o canal não tem rota respondendo, e 404 não conta a quem
 * varre URLs que ela existe.
 *
 * ─── Duas pontas, dois passos ───────────────────────────────────────────────
 *
 * O token deixa a gente FALAR com o provedor (o número e a conta são
 * descobertos por `/me`). O segredo de assinatura deixa o provedor falar com a
 * gente: ele nasce no painel do provedor, por número, e sem ele a entrada
 * recusa tudo. Nenhum dos dois volta num GET — a tela sabe que existem, não
 * quais são.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { canalGraphParceiroLigado, GRAPH_PARTNER_LABEL } from "@/lib/channels/graph-parceiro/credentials";
import {
  findGraphPartnerSession,
  saveGraphPartnerSession,
  saveGraphPartnerSigningSecret,
} from "@/lib/channels/graph-parceiro/session";
import { validateGraphPartnerCredentials } from "@/lib/channels/graph-parceiro/validate-credentials";
import { PREFIXO_DO_SEGREDO } from "@/lib/channels/graph-parceiro/webhook";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptWebhookSecret, encryptWebhookSecret } from "@/lib/webhooks/secrets";
import { basePublicaDaInstalacao } from "@/lib/webhooks/url-publica";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const conectarSchema = z.object({ token: z.string().trim().min(20).max(500) });
const segredoSchema = z.object({
  signing_secret: z.string().trim().min(16).max(500).startsWith(PREFIXO_DO_SEGREDO),
});

function naoExiste(requestId: string): NextResponse {
  return fail("not_found", "not found", 404, { requestId });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  if (!canalGraphParceiroLigado()) return naoExiste(requestId);
  // Conectar um canal move dinheiro e expõe a conta da empresa: decisão de dono.
  const authz = await requireRole("admin", { requestId, resource: "channels_graph_partner" });
  if (!authz.ok) return authz.response;

  const admin = createAdminClient();
  const sessao = await findGraphPartnerSession(admin, authz.org.orgId);
  const ativa = sessao && !sessao.archivedAt ? sessao : null;

  // Decifrar só para responder SIM ou NÃO: o segredo em si nunca sai daqui.
  const segredo = ativa?.webhookSecretEncrypted
    ? await decryptWebhookSecret(admin, ativa.webhookSecretEncrypted)
    : null;

  return ok(
    {
      label: GRAPH_PARTNER_LABEL,
      connected: Boolean(ativa),
      channel_session_id: ativa?.id ?? null,
      has_token: Boolean(ativa?.hasToken),
      has_signing_secret: Boolean(segredo?.startsWith(PREFIXO_DO_SEGREDO)),
      phone_number_id: ativa?.phoneNumberId ?? null,
      waba_id: ativa?.wabaId ?? null,
      display_name: ativa?.displayName ?? null,
      phone_number: ativa?.phoneNumber ?? null,
      status: ativa?.status ?? null,
      webhook_url: ativa?.webhookPathToken
        ? `${basePublicaDaInstalacao(req)}/api/v1/webhooks/channel/${ativa.webhookPathToken}`
        : null,
    },
    { requestId },
  );
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  if (!canalGraphParceiroLigado()) return naoExiste(requestId);
  const authz = await requireRole("admin", { requestId, resource: "channels_graph_partner" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;

  const parsed = conectarSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("invalid_request", t("Informe o token do provedor parceiro."), 422, { requestId });
  }

  // Valida ANTES de gravar: gravar primeiro e descobrir depois é o operador
  // achando que conectou até a primeira mensagem que não sai.
  const validacao = await validateGraphPartnerCredentials({ token: parsed.data.token });
  if (!validacao.ok) return fail("invalid_request", validacao.motivo, 422, { requestId });

  const admin = createAdminClient();
  const tokenCifrado = await encryptWebhookSecret(admin, parsed.data.token);
  // Provisório e aleatório, NUNCA `whsec_`: a entrada recusa tudo até o
  // operador colar o segredo do painel (ver `saveGraphPartnerSession`).
  const provisorioCifrado = await encryptWebhookSecret(admin, randomBytes(32).toString("hex"));
  if (!tokenCifrado || !provisorioCifrado) {
    // Sem a cifra, gravar o token em claro seria pior que recusar.
    return fail(
      "invalid_request",
      t("cifra indisponível nesta instalação — a chave não foi gravada"),
      422,
      { requestId },
    );
  }

  const existente = await findGraphPartnerSession(admin, orgId);
  const phoneNumber = validacao.displayPhoneNumber
    ? `+${validacao.displayPhoneNumber.replace(/\D/g, "")}`
    : null;
  const displayName = validacao.verifiedName ?? GRAPH_PARTNER_LABEL;

  const { error, channelSessionId } = await saveGraphPartnerSession(admin, {
    organizationId: orgId,
    existente,
    phoneNumberId: validacao.phoneNumberId,
    wabaId: validacao.wabaId,
    tokenEncrypted: tokenCifrado,
    segredoProvisorioCifrado: provisorioCifrado,
    phoneNumber,
    displayName,
    userId: authz.user.id,
    requestId,
  });
  if (error) return fail("internal_error", error, 500, { requestId });

  // A volta de um canal arquivado já é auditada por `reactivateChannelSession`
  // (`channel.reactivated`); aqui fica a conexão nova e a troca de token.
  if (!existente?.archivedAt) {
    void audit({
      action: "channel.connected",
      actorUserId: authz.user.id,
      organizationId: orgId,
      resourceType: "channel_session",
      resourceId: channelSessionId,
      requestId,
      metadata: { canal: "graph_partner", etapa: "token", phone_number: phoneNumber },
    });
  }

  return ok(
    { connected: true, phone_number: phoneNumber, display_name: displayName },
    { requestId },
  );
}

export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  if (!canalGraphParceiroLigado()) return naoExiste(requestId);
  const authz = await requireRole("admin", { requestId, resource: "channels_graph_partner" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;

  const parsed = segredoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail(
      "invalid_request",
      t("Cole o segredo de assinatura do painel do provedor (começa com whsec_)."),
      422,
      { requestId },
    );
  }

  const admin = createAdminClient();
  const sessao = await findGraphPartnerSession(admin, orgId);
  if (!sessao || sessao.archivedAt) {
    return fail("state_conflict", t("Conecte o número com o token antes de gravar o segredo."), 409, {
      requestId,
    });
  }

  const cifrado = await encryptWebhookSecret(admin, parsed.data.signing_secret);
  if (!cifrado) {
    return fail(
      "invalid_request",
      t("cifra indisponível nesta instalação — a chave não foi gravada"),
      422,
      { requestId },
    );
  }

  const { error } = await saveGraphPartnerSigningSecret(admin, {
    organizationId: orgId,
    channelSessionId: sessao.id,
    secretEncrypted: cifrado,
  });
  if (error) return fail("internal_error", error, 500, { requestId });

  void audit({
    action: "channel.connected",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "channel_session",
    resourceId: sessao.id,
    requestId,
    metadata: { canal: "graph_partner", etapa: "assinatura_do_webhook" },
  });

  return ok({ has_signing_secret: true }, { requestId });
}
