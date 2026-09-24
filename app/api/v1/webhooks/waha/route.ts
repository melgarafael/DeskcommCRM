/**
 * POST /api/v1/webhooks/waha — global webhook receiver (no path token).
 *
 * Usado quando o WAHA tem um único WHATSAPP_HOOK_URL global (docker-compose
 * atual). Resolve a channel_session por `body.session` (= waha_session_name).
 * A variante /waha/[token] é a rota per-tenant canônica de produção.
 *
 * Pipeline: lookup session -> verifica HMAC SHA512 -> loga em
 * webhook_events_log -> dispatchWahaEvent (ingestão compartilhada, ver
 * lib/waha/ingest.ts). Idempotência e resolução atômica de contato/conversa
 * vivem no módulo compartilhado.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { ARCHIVED_AT, queryTolerantToMissingArchived } from "@/lib/channels/archived";
import { carregarComportamentoDaInstalacao } from "@/lib/instalacao/comportamento-servidor";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { conferirContratoWaha, lerRoteamentoWaha } from "@/lib/waha/envelope";
import { dispatchWahaEvent } from "@/lib/waha/ingest";
import { authenticateWahaWebhook } from "@/lib/waha/webhook-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  const rawBody = await req.text();
  // ─── O contrato do fio, em DOIS momentos ─────────────────────────────────
  //
  // Isto era `JSON.parse(rawBody) as WahaEnvelope`: um cast, que não checa nada
  // em tempo de execução. Um `payload.from` não-string fazia `parseChatId`
  // lançar lá dentro, o `catch` do dispatch engolia, e a rota devolvia **200** —
  // o provider riscava o evento da fila achando que entregou.
  //
  // O estágio 1 confere só o que é preciso para RESOLVER O TENANT e ARQUIVAR o
  // corpo: aqui a `session` do corpo resolve a organização, e o id da mensagem
  // vai numa coluna do arquivo. O contrato completo não pode barrar o arquivo,
  // porque o AC do `docs/prd/03-prd-whatsapp-waha.md` §3.3 manda gravar o raw
  // "mesmo se o parse falhar depois" — e o corpo cru de um payload cujo
  // formato mudou é justamente o artefato que responde o que mudou.
  //
  // Desfecho da recusa: 400 com os CAMPOS (nunca os valores: são dado de
  // cliente e podem ter megabytes) e uma linha no log estruturado. O 400 é
  // escolhido por ser BARULHENTO: payload fora do contrato não é "evento que
  // não interessa" — é o fio ter mudado, e um 200 diria que deu tudo certo. Não
  // 500, porque o defeito está no corpo recebido, não numa falha nossa.
  //
  // Esta escolha NÃO se apoia em como o provider reage ao 400 (se reentrega,
  // quantas vezes, se desiste): isso nunca foi medido contra o WAHA.
  //
  // O schema é LOOSE: campo desconhecido passa intacto. Ver lib/waha/envelope.ts.
  const roteamento = lerRoteamentoWaha(rawBody);
  if (!roteamento.ok) {
    if (roteamento.motivo === "json_invalido") {
      return fail("invalid_request", "invalid_json", 400, { requestId });
    }
    // `error`, e aqui isto está certo: o Caddy do kit responde 403 para este
    // caminho exato (`Caddyfile`, `@waha_global`), então quem chega aqui é o
    // WAHA pela rede interna. Recusa de contrato nesta rota é o fio ter mudado.
    // Na rota por token, que é pública de propósito, o mesmo log é `warn`.
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

  const sessionName = roteado.session;
  if (!sessionName) {
    return fail("invalid_request", "missing session field", 400, { requestId });
  }

  const admin = createAdminClient();

  // Canal ARQUIVADO não ingere — mesmo motivo da rota per-tenant: a sessão já foi
  // removida do transporte, e o que ainda chega é evento em voo. Cai no ramo
  // `session_not_registered` abaixo, que responde 200.
  const base = () =>
    admin
      .from("channel_sessions")
      .select(
        "id, organization_id, waha_session_name, webhook_secret_encrypted, status, is_warmup_complete, warmup_started_at",
      )
      .eq("waha_session_name", sessionName);
  const { data: session, error: sessErr } = await queryTolerantToMissingArchived(
    () => base().is(ARCHIVED_AT, null).maybeSingle(),
    () => base().maybeSingle(),
  );

  if (sessErr) {
    return fail("internal_error", sessErr.message, 500, { requestId });
  }
  if (!session) {
    // Sessão ainda não registrada no nosso DB — aceita e ignora. Comum quando a
    // sessão foi iniciada pelo dashboard antes da nossa linha existir, e por isso
    // 200: aqui NÃO houve defeito nenhum no corpo, ao contrário da recusa de
    // contrato acima. O que o WAHA faz com um 4xx aqui nunca foi medido, e esta
    // escolha não se apoia nisso.
    return ok(
      { accepted: false, reason: "session_not_registered", session: sessionName },
      { requestId },
    );
  }

  // Autenticação fail-closed — regras e o porquê em lib/waha/webhook-auth.ts.
  const sigHeader = req.headers.get("x-webhook-hmac") ?? req.headers.get("X-Webhook-Hmac");
  let sessionSecret: string | null = null;
  try {
    const dec = await admin.rpc("fn_decrypt_oauth", {
      ciphertext: session.webhook_secret_encrypted,
    });
    if (!dec.error && typeof dec.data === "string") sessionSecret = dec.data;
  } catch {
    sessionSecret = null;
  }

  // O portão lê a exigência de assinatura da MEMÓRIA do processo, de forma
  // síncrona. Sem carregar a linha da instalação aqui, um processo recém-subido
  // responde com o piso do `.env` até alguém abrir outra tela que a carregue —
  // e a escolha feita em /admin/sistema não vale para a entrada de mensagens.
  // O memo de 30 s faz disto no máximo uma leitura por janela; nunca lança.
  await carregarComportamentoDaInstalacao();
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
  // Estágio 2: o resto do contrato. Conferido ANTES do INSERT para a linha já
  // nascer com o desfecho — o corpo cru é arquivado nos dois casos. Gravar
  // `received` e corrigir depois abriria uma janela (e um segundo write que pode
  // falhar) em que a recusa fica com a mesma palavra de um evento que deu certo.
  const contrato = conferirContratoWaha(roteado);

  await admin.from("webhook_events_log").insert({
    organization_id: session.organization_id,
    channel_session_id: session.id,
    provider: "waha",
    webhook_path_token: null,
    http_method: "POST",
    headers: headersJson,
    raw_body: rawBody,
    payload_parsed: roteado as unknown as Record<string, unknown>,
    signature_header: sigHeader ?? null,
    valid_signature: validSignature,
    event_type: eventType,
    external_id: externalId,
    status: contrato.ok ? "received" : "error",
    // Só os NOMES dos campos: o valor recusado é dado de cliente.
    error_message: contrato.ok ? null : `${contrato.motivo}: ${contrato.campos.join(", ")}`,
    attempts: 0,
  });

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
