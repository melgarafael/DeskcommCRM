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
 * não qual é. O segredo do webhook volta UMA vez, na gravação, e só quando o
 * operador precisa colá-lo do outro lado: depois de gravar, a rota registra o
 * webhook no provedor com a própria chave, filtrado ao número, e só quando o
 * provedor recusa (chave sem permissão de webhook) a tela volta a pedir o
 * passo manual. A conexão por UM CLIQUE, pela conta da instalação, é a rota
 * irmã `./um-clique`.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { audit } from "@/lib/audit";
import { umCliqueDisponivel } from "@/lib/channels/conexao-um-clique";
import {
  PARTNER_CHANNEL_LABEL,
  findPartnerSession,
  partnerEndpoint,
  registrarWebhookDoNumero,
  savePartnerSession,
  segredoAtualDoWebhook,
  validatePartnerCredentials,
} from "@/lib/channels/connect";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";
import { basePublicaDaInstalacao } from "@/lib/webhooks/url-publica";
import { traduzir } from "@/lib/i18n/dicionario";
import { traduzirLimiteDoPlano } from "@/lib/cobranca/limites";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const conectarSchema = z.object({
  account_id: z.string().trim().min(1).max(200),
  api_key: z.string().trim().min(8).max(500),
});

/**
 * Endereço público desta instalação — é o que o operador cola no provedor.
 *
 * A base sai de `lib/webhooks/url-publica` desde a fatia F1 da #850: a mesma
 * pergunta ("qual é o endereço público desta instalação?") era respondida em três
 * rotas, e a resposta divergente entre elas é um webhook que a tela promete num
 * endereço e o produto atende em outro. O porquê do `env.*` no lugar do
 * `process.env.NEXT_PUBLIC_APP_URL` direto está documentado lá.
 */
function urlDoWebhook(req: NextRequest, token: string): string {
  return `${basePublicaDaInstalacao(req)}/api/v1/webhooks/channel/${token}`;
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
  const umClique = await umCliqueDisponivel();

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
      /** Endpoint base do parceiro — para o operador reaproveitar em outro sistema. */
      endpoint: conectado ? partnerEndpoint() : null,
      webhook_url:
        conectado && sessao.webhookPathToken ? urlDoWebhook(req, sessao.webhookPathToken) : null,
      /** A instalação tem conta no provedor: a tela oferece a conexão por um clique. */
      um_clique: umClique,
      pela_instalacao: conectado ? sessao.pelaInstalacao : false,
      webhook_automatico: conectado ? sessao.webhookId !== null : false,
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
  const existente = await findPartnerSession(admin, orgId);
  // A conexão por um clique fala pela conta da INSTALAÇÃO, e o número está na
  // fatura dela: gravar uma chave própria por cima deixaria esse número e o
  // webhook dele órfãos lá. Excluir a conexão primeiro desfaz os dois.
  if (existente && !existente.archivedAt && existente.pelaInstalacao) {
    return fail(
      "state_conflict",
      t("Este número foi conectado pela instalação. Para usar a sua chave, exclua a conexão atual em Conexões antes."),
      409,
      { requestId },
    );
  }
  const chaveCifrada = await encryptWebhookSecret(admin, parsed.data.api_key);
  // Segredo do webhook: é o que autentica o que ENTRA. Sem ele a rota de entrada
  // recusa tudo — que é o comportamento certo, mas o canal ficaria mudo. Ao
  // reconectar, o MESMO segredo: a assinatura que já entrega continua valendo
  // enquanto recebe o filtro, e nenhum evento se perde na troca.
  const segredoAtual = existente ? await segredoAtualDoWebhook(admin, orgId, existente.id) : null;
  const segredoWebhook = segredoAtual ?? randomBytes(32).toString("hex");
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

  // Reconectar por cima de um canal excluído RESSUSCITA a linha, e o token de
  // webhook é preservado para não invalidar o que já está colado do outro lado.
  const token = existente?.webhookPathToken ?? randomBytes(16).toString("hex");
  // O nome do provedor só batiza a conexão; depois dela o nome é do operador
  // (Renomear), e salvar a credencial de novo não o apaga.
  const displayName = existente?.displayName || (v.displayName ?? PARTNER_CHANNEL_LABEL);

  const { error, id } = await savePartnerSession(admin, {
    organizationId: orgId,
    existingId: existente?.id ?? null,
    accountId: parsed.data.account_id.trim(),
    credencial: { tipo: "propria", apiKeyEncrypted: chaveCifrada },
    webhookPathToken: token,
    webhookSecretEncrypted: segredoCifrado,
    phoneNumber: v.phoneNumber ? `+${v.phoneNumber.replace(/\D/g, "")}` : null,
    displayName,
  });
  if (error) {
    // `savePartnerSession` devolve só a mensagem: é ela que carrega o limite do plano.
    const limite = traduzirLimiteDoPlano(error, authz.user.idioma);
    if (limite) return fail(limite.code, limite.message, 409, { requestId, details: limite.details });
    return fail("internal_error", error, 500, { requestId });
  }

  const webhookId = id
    ? await registrarWebhookDoNumero(admin, {
        organizationId: orgId,
        sessionId: id,
        apiKey: parsed.data.api_key,
        accountId: parsed.data.account_id.trim(),
        url: urlDoWebhook(req, token),
        segredo: segredoWebhook,
        segredoNovo: segredoAtual === null,
      })
    : null;

  void audit({
    action: "channel.connected",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "channel_session",
    resourceId: id,
    requestId,
    metadata: { canal: "parceiro", modo: "chave_propria", webhook: webhookId ? "registrado" : "manual" },
  });

  return ok(
    {
      connected: true,
      phone_number: v.phoneNumber ? `+${v.phoneNumber.replace(/\D/g, "")}` : null,
      display_name: displayName,
      quality_rating: v.qualityRating,
      webhook_url: urlDoWebhook(req, token),
      webhook_automatico: webhookId !== null,
      // Volta UMA vez, e só quando o operador precisa colá-lo no provedor: com o
      // webhook registrado pela rota, não há o que colar.
      webhook_secret: webhookId ? null : segredoWebhook,
    },
    { requestId },
  );
}
