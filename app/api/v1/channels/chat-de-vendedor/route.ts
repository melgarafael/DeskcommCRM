/**
 * GET  /api/v1/channels/chat-de-vendedor — estado da conexão + o que colar no provedor.
 * POST /api/v1/channels/chat-de-vendedor — VALIDA o token (e registra o webhook) e
 *                                          só então grava.
 *
 * O canal do chat de vendedor (issue #2927) — a marca mora no seam
 * (`lib/channels/chat-de-vendedor/`), nunca aqui. O caminho e o corpo não
 * citam o provider: quem é, como se chamam as colunas e como se valida o token
 * estão em `lib/channels/chat-de-vendedor/` (`lint:channels`).
 *
 * ─── Desligado por padrão (molde do #1459) ──────────────────────────────────
 *
 * Canal opcional da INSTALAÇÃO. Com o interruptor desligado, as duas respondem
 * 404 antes de qualquer outra coisa: quem não ligou o canal não tem rota
 * respondendo, e 404 não conta a quem varre URLs que ela existe.
 *
 * ─── Uma ponta, um passo ────────────────────────────────────────────────────
 *
 * O access token deixa a gente FALAR com o provedor (envio e registro do webhook).
 * Ele nunca volta num GET — a tela sabe que existe, não qual é. O mesmo POST
 * que grava o token também REGISTRA o webhook na conta do vendedor: é o
 * aperto de mão que a doc pública descreve, e validá-lo antes de gravar é o
 * que impede o operador achar que conectou até a primeira mensagem que não sai.
 *
 * A obtenção do token em si (authorization_code, com redirect por navegador)
 * é feita pelo integrador cadastrado junto ao provedor: é o integrador quem
 * tem `client_id`/`client_secret`, e o CRM recebe o access token já na mão.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { traduzirLimiteDoPlano } from "@/lib/cobranca/limites";
import { requireRole } from "@/lib/auth/require-role";
import {
  canalChatDeVendedorLigado,
  CHAT_DE_VENDEDOR_LABEL,
} from "@/lib/channels/chat-de-vendedor/credentials";
import {
  findChatDeVendedorSession,
  saveChatDeVendedorSession,
} from "@/lib/channels/chat-de-vendedor/session";
import { validarCredencialChatDeVendedor } from "@/lib/channels/chat-de-vendedor/validate-credentials";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";
import { basePublicaDaInstalacao } from "@/lib/webhooks/url-publica";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const conectarSchema = z.object({
  token: z.string().trim().min(20).max(2000),
  /** A conta de vendedor: é a coluna de referência da sessão e o `sessionRef` do envio. */
  seller_id: z.string().trim().min(3).max(120),
});

function naoExiste(requestId: string): NextResponse {
  return fail("not_found", "not found", 404, { requestId });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  if (!canalChatDeVendedorLigado()) return naoExiste(requestId);
  // Conectar um canal move dinheiro e expõe a conta da empresa: decisão de dono.
  const authz = await requireRole("admin", { requestId, resource: "channels_chat_de_vendedor" });
  if (!authz.ok) return authz.response;

  const admin = createAdminClient();
  const sessao = await findChatDeVendedorSession(admin, authz.org.orgId);
  const ativa = sessao && !sessao.archivedAt ? sessao : null;

  return ok(
    {
      label: CHAT_DE_VENDEDOR_LABEL,
      connected: Boolean(ativa),
      channel_session_id: ativa?.id ?? null,
      has_token: Boolean(ativa?.hasToken),
      seller_id: ativa?.sellerId ?? null,
      display_name: ativa?.displayName ?? null,
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
  if (!canalChatDeVendedorLigado()) return naoExiste(requestId);
  const authz = await requireRole("admin", { requestId, resource: "channels_chat_de_vendedor" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;

  const parsed = conectarSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail(
      "invalid_request",
      t("Informe o access token do provedor e a conta de vendedor."),
      422,
      { requestId },
    );
  }

  // O token do path desta conexão: aleatório, e é ele que a rota do webhook vai
  // conferir a cada entrega. Gerado ANTES do aperto de mão porque o próprio
  // handshake registra ESTA url na conta do vendedor.
  const webhookPathToken = randomBytes(24).toString("hex");
  const webhookUrl = `${basePublicaDaInstalacao(req)}/api/v1/webhooks/channel/${webhookPathToken}`;

  // Valida ANTES de gravar: o mesmo aperto de mão que a doc pública descreve
  // (POST no serviço de chat com o webhook) só responde 2xx para quem tem um
  // access token com scope `chat`.
  const validacao = await validarCredencialChatDeVendedor({
    token: parsed.data.token,
    webhookUrl,
  });
  if (!validacao.ok) return fail("invalid_request", validacao.motivo, 422, { requestId });

  const admin = createAdminClient();
  const tokenCifrado = await encryptWebhookSecret(admin, parsed.data.token);
  // Provisório e aleatório: a coluna é NOT NULL por herança do schema, e este
  // canal não tem segredo de assinatura (o provedor não assina o webhook) — quem
  // autentica a entrega é o token do path acima. Gravar o access token aqui
  // seria guardar a mesma credencial duas vezes.
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

  const existente = await findChatDeVendedorSession(admin, orgId);
  // O nome do provedor só batiza a conexão; depois dela o nome é do operador
  // (Renomear), e salvar o token de novo não o apaga.
  const displayName = existente?.displayName || CHAT_DE_VENDEDOR_LABEL;

  const { error, channelSessionId } = await saveChatDeVendedorSession(admin, {
    organizationId: orgId,
    existente,
    sellerId: parsed.data.seller_id,
    tokenEncrypted: tokenCifrado,
    segredoProvisorioCifrado: provisorioCifrado,
    webhookPathToken,
    displayName,
    userId: authz.user.id,
    requestId,
  });
  if (error) {
    // `saveChatDeVendedorSession` devolve só a mensagem: é ela que carrega o limite do plano.
    const limite = traduzirLimiteDoPlano(error, authz.user.idioma);
    if (limite) return fail(limite.code, limite.message, 409, { requestId, details: limite.details });
    return fail("internal_error", error, 500, { requestId });
  }

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
      metadata: { canal: "chat_de_vendedor", etapa: "token", seller_id: parsed.data.seller_id },
    });
  }

  return ok(
    { connected: true, seller_id: parsed.data.seller_id, webhook_url: webhookUrl },
    { requestId },
  );
}
