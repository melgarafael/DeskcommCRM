import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/channels/partner — estado da conexão por credencial + o que colar no provedor.
 * POST /api/v1/channels/partner — VALIDA a credencial e só então grava.
 *
 * O caminho não cita o canal, e o corpo desta rota também não: quem é o
 * "parceiro", como se chamam as colunas dele e como se valida a chave estão em
 * `lib/channels/connect`. A primeira versão escrevia as colunas daqui e o
 * `lint:channels` reprovou — a catraca funcionando, porque nome de coluna com
 * provider dentro de uma rota é a feature sabendo com quem fala.
 *
 * Valida ANTES de gravar, como a conexão oficial e pelo mesmo motivo: gravar
 * primeiro e descobrir depois é o que faz o operador achar que conectou e só
 * entender que não na primeira mensagem que não sai, com o lead esperando.
 *
 * A chave **nunca volta num GET**. Uma vez gravada, a tela mostra que existe,
 * não qual é. O segredo do webhook volta UMA vez, na gravação, porque o
 * operador precisa colá-lo do outro lado — depois disso, nunca mais.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import {
  PARTNER_CHANNEL_LABEL,
  findPartnerSession,
  savePartnerSession,
  validatePartnerCredentials,
} from "@/lib/channels/connect";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const conectarSchema = z.object({
  account_id: z.string().trim().min(1).max(200),
  api_key: z.string().trim().min(8).max(500),
});

/**
 * Endereço público desta instalação — é o que o operador cola no provedor.
 *
 * `env.*` e NÃO `process.env.NEXT_PUBLIC_APP_URL` direto: variáveis
 * `NEXT_PUBLIC_` são substituídas no BUILD, e a imagem genérica do self-host é
 * construída com `https://placeholder.invalid` (Dockerfile). Lendo direto do
 * `process.env`, a tela mostrava essa URL — e quem a colasse no provedor
 * apontaria o webhook para o nada, sem nenhum erro em lugar nenhum. `env.*`
 * parseia em runtime, então a imagem serve qualquer domínio.
 *
 * O host da requisição é o fallback: numa instalação que esqueceu a variável,
 * o endereço por onde a tela está sendo servida é a melhor pista que existe —
 * e melhor que um placeholder que não resolve.
 */
function urlDoWebhook(req: NextRequest, token: string): string {
  const configurada = env.NEXT_PUBLIC_APP_URL;
  const usavel = configurada && !configurada.includes("placeholder.invalid") ? configurada : null;
  const base = (
    usavel ??
    req.headers.get("origin") ??
    `${req.nextUrl.protocol}//${req.nextUrl.host}`
  ).replace(/\/+$/, "");
  return `${base}/api/v1/webhooks/channel/${token}`;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  // Conectar um canal move dinheiro e expõe a conta da empresa: é decisão de
  // dono, não de quem atende.
  const authz = await requireRole("admin", { requestId, resource: "channels_partner" });
  if (!authz.ok) return authz.response;
  const orgId = authz.org.orgId;

  const sessao = await findPartnerSession(createAdminClient(), orgId);
  const conectado = !!sessao && !sessao.archivedAt;

  return ok(
    {
      label: PARTNER_CHANNEL_LABEL,
      connected: conectado,
      channel_session_id: conectado ? sessao.id : null,
      account_id: conectado ? sessao.accountId : null,
      phone_number: conectado ? sessao.phoneNumber : null,
      display_name: conectado ? sessao.displayName : null,
      status: conectado ? sessao.status : null,
      // Existe, não qual é.
      has_api_key: conectado ? sessao.hasApiKey : false,
      webhook_url:
        conectado && sessao.webhookPathToken ? urlDoWebhook(req, sessao.webhookPathToken) : null,
    },
    { requestId },
  );
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  // Conectar um canal move dinheiro e expõe a conta da empresa: é decisão de
  // dono, não de quem atende.
  const authz = await requireRole("admin", { requestId, resource: "channels_partner" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;

  const parsed = conectarSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("invalid_request", t("account_id e api_key são obrigatórios"), 422, { requestId });
  }

  // A rota não sabe com quem fala: pergunta se a credencial presta e o canal responde.
  const v = await validatePartnerCredentials({
    accountId: parsed.data.account_id,
    apiKey: parsed.data.api_key,
  });
  if (!v.ok) return fail("invalid_request", v.reason, 422, { requestId });

  const admin = createAdminClient();
  const chaveCifrada = await encryptWebhookSecret(admin, parsed.data.api_key);
  // Segredo do webhook: é o que autentica o que ENTRA. Sem ele a rota de entrada
  // recusa tudo — que é o comportamento certo, mas o canal ficaria mudo.
  const segredoWebhook = randomBytes(32).toString("hex");
  const segredoCifrado = await encryptWebhookSecret(admin, segredoWebhook);

  if (!chaveCifrada || !segredoCifrado) {
    // Sem a GUC de cifra, gravar a chave em claro seria pior que recusar. O
    // operador precisa saber que falta configuração de servidor.
    return fail(
      "invalid_request",
      t("cifra indisponível nesta instalação — a chave não foi gravada"),
      422,
      { requestId },
    );
  }

  const existente = await findPartnerSession(admin, orgId);
  // Reconectar por cima de um canal excluído RESSUSCITA a linha, e o token de
  // webhook é preservado para não invalidar o que já está colado do outro lado.
  const token = existente?.webhookPathToken ?? randomBytes(16).toString("hex");

  const { error } = await savePartnerSession(admin, {
    organizationId: orgId,
    existingId: existente?.id ?? null,
    accountId: parsed.data.account_id.trim(),
    apiKeyEncrypted: chaveCifrada,
    webhookPathToken: token,
    webhookSecretEncrypted: segredoCifrado,
    phoneNumber: v.phoneNumber ? `+${v.phoneNumber.replace(/\D/g, "")}` : null,
    displayName: v.displayName ?? PARTNER_CHANNEL_LABEL,
  });
  if (error) return fail("internal_error", error, 500, { requestId });

  return ok(
    {
      connected: true,
      phone_number: v.phoneNumber ? `+${v.phoneNumber.replace(/\D/g, "")}` : null,
      display_name: v.displayName ?? PARTNER_CHANNEL_LABEL,
      quality_rating: v.qualityRating,
      webhook_url: urlDoWebhook(req, token),
      // Volta UMA vez, porque o operador precisa colá-lo no provedor.
      webhook_secret: segredoWebhook,
    },
    { requestId },
  );
}
