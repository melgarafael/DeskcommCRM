/**
 * POST /api/v1/channels/partner/um-clique — o número oficial conectado com um clique.
 *
 *   { acao: "iniciar", coexistencia } → { url } da página de cadastro, ou a
 *     conexão já concluída quando o perfil da organização já tem o número;
 *   { acao: "concluir", estado, account_id, profile_id | erro } → a volta,
 *     entregue pela tela depois da ponte de `/auth/partner-return/…`.
 *
 * Como a rota irmã, não sabe com quem fala: o fluxo inteiro mora em
 * `lib/channels/conexao-um-clique.ts`. Aqui ficam só as guardas — papel de dono
 * (conectar move dinheiro: o número entra na fatura do provedor da instalação),
 * verificação em duas etapas, limite de tentativas — e a auditoria.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { mfaEmDivida } from "@/lib/auth/server";
import { marcaDaSaida } from "@/lib/branding/saida";
import {
  ErroDaConexaoUmClique,
  concluirConexaoUmClique,
  iniciarConexaoUmClique,
  type ContextoDaConexao,
} from "@/lib/channels/conexao-um-clique";
import { traduzirLimiteDoPlano } from "@/lib/cobranca/limites";
import { env } from "@/lib/env";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { basePublicaDaInstalacao } from "@/lib/webhooks/url-publica";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const headers = { "Cache-Control": "no-store" };

const corpoSchema = z.discriminatedUnion("acao", [
  z.object({ acao: z.literal("iniciar"), coexistencia: z.boolean() }).strict(),
  z
    .object({
      acao: z.literal("concluir"),
      estado: z.string().min(20).max(700),
      account_id: z.string().max(64).optional(),
      profile_id: z.string().max(64).optional(),
      erro: z
        .string()
        .regex(/^[a-z_]{1,60}$/)
        .optional(),
    })
    .strict(),
]);

export async function POST(req: NextRequest): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "channels_partner" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  if (await mfaEmDivida()) {
    return fail("mfa_required", t("Confirme a verificação em duas etapas."), 403, {
      requestId,
      headers,
    });
  }
  const parsed = corpoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Confira os dados da conexão."), 400, {
      requestId,
      headers,
    });
  }
  const orgId = authz.org.orgId;
  const limite = await checkRateLimit(`partner-um-clique:${orgId}`, 20, 60);
  if (!limite.allowed) {
    return fail("rate_limited", t("Aguarde um minuto antes de tentar novamente."), 429, {
      requestId,
      headers: { ...headers, "Retry-After": "60" },
    });
  }

  const admin = createAdminClient();
  const ctx: ContextoDaConexao = {
    organizationId: orgId,
    organizationNome: authz.org.name,
    userId: authz.user.id,
    idioma: authz.user.idioma,
    segredo: env.INTERNAL_SECRET,
    agora: new Date(),
    publicBase: basePublicaDaInstalacao(req),
  };
  const corpo = parsed.data;

  try {
    if (corpo.acao === "iniciar") {
      const marca = await marcaDaSaida(orgId);
      const inicio = await iniciarConexaoUmClique(admin, ctx, {
        coexistencia: corpo.coexistencia,
        marca: marca.nome,
        cor: marca.accent,
      });
      if (inicio.tipo === "pagina") return ok({ url: inicio.url }, { requestId, headers });
      auditarConexao(
        requestId,
        ctx,
        inicio.channelSessionId,
        inicio.webhookRegistrado,
        "perfil_ja_tinha_o_numero",
      );
      return ok(paraResposta(inicio), { requestId, headers });
    }
    const concluida = await concluirConexaoUmClique(admin, ctx, {
      estado: corpo.estado,
      accountId: corpo.account_id,
      profileId: corpo.profile_id,
      erro: corpo.erro,
    });
    auditarConexao(
      requestId,
      ctx,
      concluida.channelSessionId,
      concluida.webhookRegistrado,
      "volta_da_meta",
    );
    return ok(paraResposta(concluida), { requestId, headers });
  } catch (erro) {
    if (erro instanceof ErroDaConexaoUmClique) {
      return fail(erro.code, t(erro.message), erro.status, {
        requestId,
        headers,
        details: erro.details,
      });
    }
    const limiteDoPlano = traduzirLimiteDoPlano(erro, authz.user.idioma);
    if (limiteDoPlano) {
      return fail(limiteDoPlano.code, limiteDoPlano.message, 409, {
        requestId,
        headers,
        details: limiteDoPlano.details,
      });
    }
    logger.warn("[channels.partner.um-clique] conexão não concluída", {
      organization_id: orgId,
      acao: corpo.acao,
      erro: erro instanceof Error ? erro.message : String(erro),
    });
    return fail(
      "upstream_unavailable",
      t("Não foi possível concluir a conexão. Tente novamente."),
      502,
      {
        requestId,
        headers,
      },
    );
  }
}

function paraResposta(c: {
  channelSessionId: string;
  phoneNumber: string | null;
  displayName: string;
  webhookRegistrado: boolean;
}) {
  return {
    connected: true,
    channel_session_id: c.channelSessionId,
    phone_number: c.phoneNumber,
    display_name: c.displayName,
    webhook_automatico: c.webhookRegistrado,
  };
}

function auditarConexao(
  requestId: string,
  ctx: ContextoDaConexao,
  channelSessionId: string,
  webhookRegistrado: boolean,
  origem: "volta_da_meta" | "perfil_ja_tinha_o_numero",
) {
  void audit({
    action: "channel.connected",
    actorUserId: ctx.userId,
    organizationId: ctx.organizationId,
    resourceType: "channel_session",
    resourceId: channelSessionId,
    requestId,
    metadata: {
      canal: "parceiro",
      modo: "um_clique",
      origem,
      webhook: webhookRegistrado ? "registrado" : "falhou",
    },
  });
}
