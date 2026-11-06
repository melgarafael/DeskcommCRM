import { randomUUID } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import {
  acharSessaoDoRobo,
  conectarRobo,
  ROTULO_DO_CANAL,
} from "@/lib/channels/bot/connect";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { basePublicaDaInstalacao } from "@/lib/webhooks/url-publica";

/**
 * GET  /api/v1/channels/bot — estado da conexão do robô.
 * POST /api/v1/channels/bot — VALIDA o token, registra o webhook e só então grava.
 *
 * O caminho e o corpo NÃO citam o provider: quem é, como se chamam as colunas,
 * como se valida o token e como se registra a URL moram em
 * `lib/channels/bot/`, e é o `lint:channels` (invariante 1 da doutrina
 * `restricao-de-canal.md`) que cobra isso — ele reprova nome de provider fora
 * de `lib/channels/`, e esta rota é justamente o lugar onde ele seria tentador.
 *
 * Nenhuma das duas respostas devolve o token do robô nem o segredo do webhook: a
 * tela sabe que eles existem (`has_token`), não quais são.
 *
 * ─── Por que conectar é UM passo, e não dois ───────────────────────────────
 *
 * O `setWebhook` não é opcional: um robô cuja URL não foi registrada recebe a
 * mensagem do cliente no aplicativo e nunca a entrega aqui. Se a tela tivesse
 * "conectar" e depois "registrar", o segundo seria esquecido — e o sintoma ("o
 * cliente escreveu e não apareceu nada") não aponta para ele.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const conectarSchema = z.object({ token: z.string().trim().min(20).max(200) });

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "channels_bot" });
  if (!authz.ok) return authz.response;

  const admin = createAdminClient();
  const sessao = await acharSessaoDoRobo(admin, authz.org.orgId);
  const ativa = sessao && !sessao.archivedAt ? sessao : null;

  return ok(
    {
      label: ROTULO_DO_CANAL,
      connected: Boolean(ativa),
      channel_session_id: ativa?.id ?? null,
      bot_id: ativa?.botId ?? null,
      display_name: ativa?.displayName ?? null,
      status: ativa?.status ?? null,
      has_token: Boolean(ativa?.hasToken),
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
  // Conectar um canal expõe a conta da empresa: decisão de dono.
  const authz = await requireRole("admin", { requestId, resource: "channels_bot" });
  if (!authz.ok) return authz.response;

  const parsed = conectarSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("invalid_request", "Informe o token do robô (@BotFather).", 422, { requestId });
  }

  const admin = createAdminClient();
  const orgId = authz.org.orgId;
  let existente;
  try {
    existente = await acharSessaoDoRobo(admin, orgId);
  } catch (err) {
    return fail("internal_error", err instanceof Error ? err.message : "lookup_failed", 500, { requestId });
  }

  const resultado = await conectarRobo(admin, {
    organizationId: orgId,
    token: parsed.data.token,
    existente,
    webhookUrlBase: basePublicaDaInstalacao(req),
    userId: authz.user.id,
    requestId,
  });
  if (!resultado.ok) {
    return fail("invalid_request", resultado.reason, resultado.status, { requestId });
  }

  // A volta de um canal arquivado já é auditada por `reactivateChannelSession`.
  if (!existente?.archivedAt) {
    void audit({
      action: "channel.connected",
      actorUserId: authz.user.id,
      organizationId: orgId,
      resourceType: "channel_session",
      resourceId: resultado.channelSessionId,
      requestId,
      // NUNCA o token: o id do robô é público dentro da plataforma e basta para
      // quem for investigar.
      metadata: { canal: "bot", bot_id: resultado.bot.id },
    });
  }

  return ok(
    {
      connected: true,
      bot_id: resultado.bot.id,
      bot_username: resultado.bot.username,
      display_name: resultado.bot.firstName,
      webhook_url: resultado.webhookUrl,
    },
    { requestId },
  );
}
