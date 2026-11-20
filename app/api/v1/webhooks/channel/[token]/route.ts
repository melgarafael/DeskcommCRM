/**
 * POST /api/v1/webhooks/channel/[token] — entrada por token, para qualquer canal.
 *
 * ─── Por que o caminho NÃO cita o canal ─────────────────────────────────────
 *
 * A família de rotas do canal por QR carrega o nome do provider na URL, e está
 * na lista de dívida do `lint:channels` por isso — sair de lá exigiria mudar
 * uma URL que já está configurada em instalação de gente. Uma rota NOVA não
 * precisa nascer devendo: o token identifica a sessão, a sessão diz qual é o
 * canal, e o caminho fica neutro. Canal seguinte entra sem uma quarta família
 * de URLs.
 *
 * ─── Por que esta rota é tão curta ──────────────────────────────────────────
 *
 * Ela não sabe de quem é o payload. Resolve o token, decifra o segredo e
 * entrega tudo a `processarEntradaDoCanal` (`../../_entrada-do-canal.ts`, o
 * mesmo caminho da entrada da instalação), que chama `handleInboundWebhook` —
 * a verificação de assinatura e a
 * leitura moram lá porque o esquema é do CANAL (header, algoritmo e formato
 * mudam por provider). A primeira versão desta rota fazia isso aqui e o
 * `lint:channels` reprovou, que é a catraca funcionando: uma rota que verifica
 * assinatura precisa perguntar qual provider é.
 *
 * ─── O 200 que evita a tempestade ──────────────────────────────────────────
 *
 * Evento que não interessa (outro tipo, eco do nosso próprio envio, outra
 * plataforma) responde 200, não 4xx: o provider reentrega o que não recebeu
 * 200, e recusar um payload que nunca vai servir faria a reentrega durar para
 * sempre. 500 fica reservado para falha de ESCRITA — aí a reentrega é o que
 * queremos, porque o evento era bom e nós é que não gravamos.
 *
 * O evento que o canal processa DEPOIS de responder (`processaDepoisDeResponder`)
 * troca o 500 por 503: ele responde 200 assim que o arquivo do webhook o
 * guardou, e o 503 é para quando nem o arquivo gravou — sem ele, o 200 não
 * teria o que garantir.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { ARCHIVED_AT, queryTolerantToMissingArchived } from "@/lib/channels/archived";
import { acceptsInboundWebhook } from "@/lib/channels/inbound";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";

import { processarEntradaDoCanal } from "../../_entrada-do-canal";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ token: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { token } = await ctx.params;

  // Token curto nunca foi emitido por nós. 404 e não 401: quem varre URLs não
  // precisa saber que a rota existe.
  if (!token || token.length < 8) {
    return fail("not_found", "unknown webhook token", 404, { requestId });
  }

  const rawBody = await req.text();
  const admin = createAdminClient();

  const { data } = await queryTolerantToMissingArchived(
    () =>
      admin
        .from("channel_sessions")
        .select(`id, organization_id, provider, display_name, phone_number, webhook_secret_encrypted, ${ARCHIVED_AT}`)
        .eq("webhook_path_token", token)
        .maybeSingle(),
    () =>
      admin
        .from("channel_sessions")
        .select("id, organization_id, provider, display_name, phone_number, webhook_secret_encrypted")
        .eq("webhook_path_token", token)
        .maybeSingle(),
  );

  const sessao = data as {
    id: string;
    organization_id: string;
    provider: string;
    display_name: string | null;
    phone_number: string | null;
    webhook_secret_encrypted: unknown;
    archived_at?: string | null;
  } | null;

  if (!sessao) return fail("not_found", "unknown webhook token", 404, { requestId });

  // Canal arquivado não ingere: o usuário mandou excluí-lo, e aceitar evento em
  // voo ressuscitaria a conversa no inbox com o operador sem poder responder.
  if (sessao.archived_at) {
    return ok({ status: "ignored", reason: "canal_arquivado" }, { requestId });
  }

  if (!acceptsInboundWebhook(sessao.provider)) {
    return fail("invalid_request", "provider_mismatch", 400, { requestId });
  }

  const cifrado = sessao.webhook_secret_encrypted;
  const secret = cifrado ? await decryptWebhookSecret(admin, cifrado as string) : null;

  return processarEntradaDoCanal(admin, {
    sessao,
    rawBody,
    headers: req.headers,
    secret,
    requestId,
  });
}
