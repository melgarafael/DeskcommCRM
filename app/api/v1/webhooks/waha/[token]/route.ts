/**
 * POST /api/v1/webhooks/waha/[token]
 *
 * Rota per-tenant canônica de produção: cada channel_session tem um
 * webhook_path_token único url-safe. Pipeline: lookup por token -> verifica
 * HMAC SHA512 -> loga em webhook_events_log -> dispatchWahaEvent (ingestão
 * compartilhada, ver lib/waha/ingest.ts).
 *
 * Idempotência e resolução atômica de contato/conversa vivem no módulo
 * compartilhado — este handler só faz auth + roteamento.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { ARCHIVED_AT, queryTolerantToMissingArchived } from "@/lib/channels/archived";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { conferirContratoWaha, lerRoteamentoWaha } from "@/lib/waha/envelope";
import { dispatchWahaEvent } from "@/lib/waha/ingest";
import { authenticateWahaWebhook } from "@/lib/waha/webhook-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteCtx {
  params: Promise<{ token: string }>;
}

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const requestId = randomUUID();
  const { token } = await ctx.params;

  if (!token || token.length < 8) {
    return fail("not_found", "unknown webhook token", 404, { requestId });
  }

  const rawBody = await req.text();
  // ─── O contrato do fio, em DOIS momentos ─────────────────────────────────
  //
  // Isto era `JSON.parse(rawBody) as WahaEnvelope`: um cast, que não checa nada
  // em tempo de execução. Um `payload.from` não-string fazia `parseChatId`
  // lançar lá dentro, o `catch` do dispatch engolia, e a rota devolvia **200** —
  // o provider riscava o evento da fila achando que entregou.
  //
  // O estágio 1 confere só o que é preciso para RESOLVER O TENANT e ARQUIVAR o
  // corpo. O contrato completo vem depois do INSERT, porque o AC do
  // `docs/prd/03-prd-whatsapp-waha.md` §3.3 manda gravar o raw "mesmo se o
  // parse falhar depois" — e o corpo cru de um payload cujo formato mudou é
  // justamente o artefato que responde o que mudou.
  //
  // Desfecho da recusa: 400 com os CAMPOS (nunca os valores: são dado de
  // cliente e podem ter megabytes) e uma linha no log estruturado. Não 200,
  // porque payload fora do contrato não é "evento que não interessa" — é o fio
  // ter mudado, e isso precisa ser barulhento. Não 500, porque o corpo é do
  // chamador, e 5xx mandaria o provider reentregar o que nunca vai passar.
  //
  // O schema é LOOSE: campo desconhecido passa intacto. Ver lib/waha/envelope.ts.
  const roteamento = lerRoteamentoWaha(rawBody);
  if (!roteamento.ok) {
    if (roteamento.motivo === "json_invalido") {
      return fail("invalid_request", "invalid_json", 400, { requestId });
    }
    logger.error("[waha.webhook] payload fora do contrato do canal", {
      request_id: requestId,
      estagio: "roteamento",
      campos: roteamento.campos,
    });
    return fail("validation_failed", "payload fora do contrato do canal", 400, {
      requestId,
      details: { campos: roteamento.campos },
    });
  }
  // Nome deliberado: isto ainda NÃO é o envelope conferido. É o que o estágio
  // 1 garante — sessão e id —, e só. Chamá-lo de `envelope` convidaria a ler
  // `payload.from` daqui, que é justamente o campo ainda não conferido.
  const roteado = roteamento.envelope;

  const admin = createAdminClient();

  // Canal ARQUIVADO não ingere: o usuário mandou excluí-lo e a sessão já foi
  // removida do WAHA. O que ainda pode chegar é evento em voo (ou retentativa),
  // e aceitá-lo ressuscitaria o canal no inbox — com o operador sem conseguir
  // responder, porque o arquivamento deixa a sessão STOPPED.
  const base = () =>
    admin
      .from("channel_sessions")
      .select(
        "id, organization_id, waha_session_name, webhook_secret_encrypted, status, is_warmup_complete, warmup_started_at",
      )
      .eq("webhook_path_token", token);
  const { data: session, error: sessErr } = await queryTolerantToMissingArchived(
    () => base().is(ARCHIVED_AT, null).maybeSingle(),
    () => base().maybeSingle(),
  );

  if (sessErr) {
    return fail("internal_error", sessErr.message, 500, { requestId });
  }
  if (!session) {
    return fail("not_found", "unknown webhook token", 404, { requestId });
  }

  if (roteado.session !== session.waha_session_name) return fail("unauthenticated", "session_mismatch", 401, { requestId });

  // Autenticação fail-closed — regras e o porquê em lib/waha/webhook-auth.ts.
  const sigHeader = req.headers.get("x-webhook-hmac-sha512") ?? req.headers.get("x-webhook-hmac");
  let sessionSecret: string | null = null;
  try {
    const dec = await admin.rpc("fn_decrypt_oauth", {
      ciphertext: session.webhook_secret_encrypted,
    });
    if (!dec.error && typeof dec.data === "string") sessionSecret = dec.data;
  } catch {
    sessionSecret = null;
  }

  const auth = authenticateWahaWebhook({ rawBody, signatureHeader: sigHeader, sessionSecret });
  if (!auth.ok) {
    await audit({
      action: "webhook.hmac_invalid",
      organizationId: session.organization_id,
      metadata: {
        provider: "waha",
        session: session.waha_session_name,
        event: roteado.event,
        reason: auth.reason,
        had_signature: Boolean(sigHeader),
      },
    });
    return fail("unauthenticated", auth.reason, 401, { requestId });
  }
  const validSignature = auth.signatureVerified;

  const eventType = roteado.event ?? "unknown";
  const externalId = roteado.payload?.id ?? null;

  const headersJson: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    if (key.toLowerCase().startsWith("authorization")) return;
    if (key.toLowerCase() === "cookie") return;
    headersJson[key] = value;
  });
  await admin.from("webhook_events_log").insert({
    organization_id: session.organization_id,
    channel_session_id: session.id,
    provider: "waha",
    webhook_path_token: token,
    http_method: "POST",
    headers: headersJson,
    raw_body: rawBody,
    payload_parsed: roteado as unknown as Record<string, unknown>,
    signature_header: sigHeader ?? null,
    valid_signature: validSignature,
    event_type: eventType,
    external_id: externalId,
    status: "received",
    attempts: 0,
  });

  // Estágio 2: o resto do contrato, agora que o corpo cru já está arquivado.
  const contrato = conferirContratoWaha(roteado);
  if (!contrato.ok) {
    logger.error("[waha.webhook] payload fora do contrato do canal", {
      request_id: requestId,
      estagio: "conteudo",
      campos: contrato.campos,
    });
    return fail("validation_failed", "payload fora do contrato do canal", 400, {
      requestId,
      details: { campos: contrato.campos },
    });
  }

  try {
    await dispatchWahaEvent(admin, session, contrato.envelope, requestId);
  } catch (err) {
    console.error("[waha.webhook] handler failed", err);
  }

  return ok({ accepted: true }, { requestId });
}
