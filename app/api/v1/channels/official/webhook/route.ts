import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/channels/official/webhook — "tentar de novo" o registro do webhook.
 *
 * Existe porque o registro automático (fatia F1, issue #850) pode falhar por motivo
 * passageiro — token recém-gerado que ainda não propagou no lado da Meta, permissão
 * que o operador estava ajustando no painel, rede. Sem esta rota, o único caminho de
 * volta seria desconectar e reconectar o canal: derrubar o que funciona para consertar
 * o que não funciona.
 *
 * ─── Ela NÃO pede a credencial de novo ───────────────────────────────────────
 * O token já está cifrado na sessão; pedir de novo faria o operador procurar um token
 * que ele talvez nem tenha mais à mão para repetir uma chamada que é do nosso lado. O
 * que ela exige é a sessão VIVA (não arquivada) e um admin — a mesma guarda da tela.
 *
 * O desfecho é o da tentativa de AGORA, e é gravado nas colunas da 0311: a tela
 * recarrega o GET e vê o estado novo, não o da tentativa anterior.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { ARCHIVED_AT, queryTolerantToMissingArchived } from "@/lib/channels/archived";
import { CHANNEL_PROVIDER_META } from "@/lib/channels/capabilities";
import { registrarWebhookDaSessao } from "@/lib/channels/meta/webhook-da-sessao";
import { createAdminClient } from "@/lib/supabase/admin";
import { basePublicaDoWebhookMeta } from "@/lib/webhooks/url-publica";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const COLUNAS =
  "id, meta_phone_number_id, meta_waba_id, meta_token_encrypted, webhook_path_token";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "channels_official_webhook" });
  if (!authz.ok) return authz.response;
  const orgId = authz.org.orgId;

  const admin = createAdminClient();
  const consultar = () =>
    admin
      .from("channel_sessions")
      .select(COLUNAS)
      .eq("organization_id", orgId)
      .eq("provider", CHANNEL_PROVIDER_META);

  // Só a sessão VIVA: reaplicar o webhook de um canal arquivado apontaria a Meta para
  // uma URL cujo `webhook_path_token` já foi rotacionado — ou seja, registraria uma
  // entrega que ninguém atende. Canal arquivado se reconecta, não se "conserta".
  const { data } = await queryTolerantToMissingArchived(
    () => consultar().is(ARCHIVED_AT, null).maybeSingle(),
    () => consultar().maybeSingle(),
  );

  const sessao = data as {
    id: string;
    meta_phone_number_id: string | null;
    meta_waba_id: string | null;
    meta_token_encrypted: string | null;
    webhook_path_token: string | null;
  } | null;

  if (!sessao || !sessao.meta_phone_number_id || !sessao.meta_waba_id || !sessao.meta_token_encrypted) {
    return fail("invalid_request", "no_meta_channel", 422, { requestId });
  }
  if (!sessao.webhook_path_token) {
    // Sessão sem token de caminho é sessão que a migration 0099 (ou o gerador do
    // INSERT) não alcançou: sem ele não há URL a registrar. Dizer isso é melhor que
    // mandar a Meta chamar `/api/v1/webhooks/meta/null`.
    return fail("invalid_request", "channel_without_webhook_path", 422, { requestId });
  }

  const desfecho = await registrarWebhookDaSessao({
    admin,
    channelSessionId: sessao.id,
    phoneNumberId: sessao.meta_phone_number_id,
    wabaId: sessao.meta_waba_id,
    tokenCifrado: sessao.meta_token_encrypted,
    webhookPathToken: sessao.webhook_path_token,
    base: basePublicaDoWebhookMeta(req),
    requestId,
  });

  // 200 mesmo quando a Meta recusou: a TENTATIVA foi feita e o desfecho é um estado
  // (com motivo), não um erro de requisição. A tela pinta o aviso com `erro` — um 4xx
  // aqui faria o cliente tratar como "deu erro" e esconder o motivo que a Meta deu.
  return ok({
    registrado: desfecho.registrado,
    url: desfecho.url,
    erro: desfecho.erro,
    em: desfecho.em,
    callbackUrl: `${basePublicaDoWebhookMeta(req)}/api/v1/webhooks/meta/${sessao.webhook_path_token}`,
  });
}
