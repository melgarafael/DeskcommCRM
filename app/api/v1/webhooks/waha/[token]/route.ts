/**
 * POST /api/v1/webhooks/waha/[token]
 *
 * Rota per-tenant canônica de produção: cada channel_session tem um
 * webhook_path_token único url-safe. Pipeline: lookup por token -> verifica
 * HMAC SHA512 -> loga em webhook_events_log -> processarEventoWaha (ingestão
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
import { carregarComportamentoDaInstalacao } from "@/lib/instalacao/comportamento-servidor";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { conferirContratoWaha, lerRoteamentoWahaPorToken } from "@/lib/waha/envelope";
import { processarEventoWaha, REENTREGA_EM_SEGUNDOS } from "@/lib/waha/desfecho-do-webhook";
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
  // O estágio 1 confere só o que é preciso para ARQUIVAR o corpo: o evento e o
  // id da mensagem. Aqui quem resolve o tenant é o token do caminho, e a
  // `session` do corpo não entra — recusá-la antes do INSERT jogava fora o corpo
  // cru por causa de um campo que esta rota nem lê. O contrato completo não
  // pode barrar o arquivo, porque o AC do `docs/prd/03-prd-whatsapp-waha.md`
  // §3.3 manda gravar o raw "mesmo se o parse falhar depois" — e o corpo cru de
  // um payload cujo formato mudou é justamente o artefato que responde o que
  // mudou.
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
  const roteamento = lerRoteamentoWahaPorToken(rawBody);
  if (!roteamento.ok) {
    if (roteamento.motivo === "json_invalido") {
      return fail("invalid_request", "invalid_json", 400, { requestId });
    }
    // `warn`, não `error`: esta recusa acontece ANTES do gate de assinatura, e
    // esta rota é pública de propósito (`Caddyfile`), então qualquer um que
    // alcance a URL a provoca. `error` aqui deixaria o log de erro à mercê de
    // quem nem tem o token. A recusa do estágio 2 continua `error` porque exige
    // o token da URL — e não porque exige assinatura: `WAHA_WEBHOOK_REQUIRE_SIGNATURE`
    // vem `false` por padrão (`lib/env.ts`), então sem header a rota segue.
    logger.warn("[waha.webhook] payload fora do contrato do canal", {
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
  // 1 garante — evento e id —, e só. Chamá-lo de `envelope` convidaria a ler
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

  const { data: arquivo } = await admin.from("webhook_events_log").insert({
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
    status: contrato.ok ? "received" : "error",
    // Só os NOMES dos campos: o valor recusado é dado de cliente.
    error_message: contrato.ok ? null : `${contrato.motivo}: ${contrato.campos.join(", ")}`,
    attempts: 0,
  }).select("id").maybeSingle();

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

  // Falha TRANSITÓRIA do banco não pode virar 200: o WAHA riscaria o evento
  // achando que entregou, e a mensagem do cliente sumiria (medido: 14/09 e
  // 24/09/2026). 503 + Retry-After pede a reentrega; a reentrega é segura porque
  // `unique (organization_id, external_id)` faz o `23505` virar dedup. Se as
  // reentregas do WAHA também não bastarem, o cron `webhook-replay` reprocessa o
  // arquivo. Ver `lib/waha/desfecho-do-webhook.ts`.
  const desfecho = await processarEventoWaha(
    admin,
    session,
    contrato.envelope,
    requestId,
    (arquivo as { id?: string } | null)?.id ?? null,
  );
  if (desfecho === "tentar_de_novo") {
    return fail("upstream_unavailable", "banco indisponível — reentregue o evento", 503, {
      requestId,
      headers: { "Retry-After": String(REENTREGA_EM_SEGUNDOS) },
    });
  }

  return ok({ accepted: true }, { requestId });
}
