/**
 * GET|POST /api/v1/webhooks/meta/[token] — webhook da WhatsApp Cloud API.
 *
 * `GET` é o handshake de verificação: a Meta só começa a entregar eventos depois
 * que o endpoint devolve `hub.challenge` **em texto puro**. Envelopar em
 * `{data:...}` (o wrapper padrão da nossa API) faz a verificação falhar com uma
 * mensagem inútil no dashboard — por isso esta é a única rota do repo que
 * responde texto cru, e está aqui escrito o motivo.
 *
 * `POST` verifica HMAC **SHA-256** com o App Secret, e só então age. O outro canal
 * do repo usa SHA-512 com segredo por sessão — não reaproveite a verificação dele;
 * o detalhe está em `lib/channels/meta/webhook.ts`.
 *
 * Por que ainda existe token no path se o App Secret é global: o segredo é do APP,
 * e um app serve N WABAs de N organizações. O token amarra o payload a UMA org
 * antes de qualquer escrita — sem ele, quem conhecesse o App Secret escreveria em
 * qualquer tenant.
 *
 * ─── De onde vêm as duas credenciais (issue #850, migration 0257) ─────────────
 *
 * Do BANCO (`platform_meta_app`), não do ambiente: as duas são da INSTALAÇÃO
 * inteira, não da organização — é isto que faz o 2º número conectar sem ninguém
 * voltar na VPS para editar `.env` e reiniciar. O `.env` continua sendo o PISO
 * (rollback, e clone que ainda não aplicou a migration) e as duas fontes NÃO se
 * misturam: segredo de um lado com verify token do outro é um app que não existe,
 * e a falha é um 401 calado que ninguém liga a configuração. A precedência, o TTL
 * e esse motivo estão escritos em `lib/channels/meta/app.ts`.
 */
import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

import { fail } from "@/lib/api/wrappers";
import { appDaMeta } from "@/lib/channels/meta/app";
import { lerEnvelopeMeta } from "@/lib/channels/meta/envelope";
import { parseMetaWebhook, verificationChallenge, verifyMetaSignature } from "@/lib/channels/meta/webhook";
import { statusUpdate } from "@/lib/channels/meta/status-update";
import { ingestMetaEcho, ingestMetaInbound } from "@/lib/channels/meta/ingest";
import { metaSessionByWebhookToken } from "@/lib/channels/meta/session";
import { logger } from "@/lib/logger";
import {
  emitirFalhaDeEntrega,
  telefoneDoEmbed,
  type EmbedDoContato,
} from "@/lib/messaging/falha-de-entrega";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteCtx {
  params: Promise<{ token: string }>;
}

export async function GET(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const { token } = await ctx.params;
  const session = await metaSessionByWebhookToken(token);
  if (!session) return new NextResponse("not found", { status: 404 });

  // Do BANCO (platform_meta_app, migration 0257), com o `.env` como piso: é a
  // credencial da INSTALAÇÃO inteira, não da organização — e um clone que ainda
  // não aplicou a migration continua verificado pelo ambiente. Não lança nunca;
  // a precedência e o porquê estão em `lib/channels/meta/app.ts`.
  const { verifyToken } = await appDaMeta();
  const challenge = verificationChallenge(req.nextUrl.searchParams, verifyToken ?? "");
  if (challenge === null) return new NextResponse("forbidden", { status: 403 });

  // Texto puro, sem wrapper — ver o cabeçalho.
  return new NextResponse(challenge, {
    status: 200,
    headers: { "content-type": "text/plain" },
  });
}

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const requestId = randomUUID();
  const { token } = await ctx.params;

  const session = await metaSessionByWebhookToken(token);
  if (!session) return fail("not_found", "unknown webhook token", 404, { requestId });

  const rawBody = await req.text();
  // Do mesmo lugar que o handshake: BANCO primeiro, `.env` como piso (0257). Sem
  // segredo nenhum configurado a verificação devolve `false` e a entrega morre em
  // 401 — que é o desfecho de hoje, e não um 500.
  const { appSecret } = await appDaMeta();
  if (!verifyMetaSignature(rawBody, req.headers.get("x-hub-signature-256"), appSecret ?? "")) {
    return fail("unauthorized", "invalid_signature", 401, { requestId });
  }

  // ─── O contrato do fio, ANTES do parser ───────────────────────────────────
  //
  // Isto era `JSON.parse(rawBody)` seguido de um `as`: cast, que não confere
  // nada em execução. `parseMetaWebhook` então faz `for (const entry of
  // envelope.entry ?? [])` — e `for...of` sobre um número LANÇA. Não há
  // try/catch em volta: a exceção subia sem ninguém tratá-la (o framework
  // responde 5xx) e a Meta reentregava em backoff um corpo que nunca melhora.
  //
  // 400 e não 200: o 200 generoso desta rota existe para EVENTO QUE NÃO NOS
  // INTERESSA (a Meta reentrega o que não recebe 2xx), e um payload fora do
  // contrato não é isso — é o fio ter mudado, que ninguém pode descobrir tarde.
  // O schema é loose e todo campo é opcional, então chegar aqui exige um campo
  // que a gente LÊ vir com o tipo errado. Ver lib/channels/meta/envelope.ts.
  const leitura = lerEnvelopeMeta(rawBody);
  if (!leitura.ok) {
    if (leitura.motivo === "json_invalido") {
      return fail("invalid_request", "invalid_json", 400, { requestId });
    }
    logger.error("[meta.webhook] payload fora do contrato do canal", {
      request_id: requestId,
      campos: leitura.campos,
    });
    return fail("validation_failed", "payload fora do contrato do canal", 400, {
      requestId,
      details: { campos: leitura.campos },
    });
  }

  const eventos = parseMetaWebhook(leitura.envelope);
  const admin = createAdminClient();
  const now = new Date().toISOString();
  /**
   * Desfecho de cada ingestão. Existe porque a versão anterior fazia
   * `await ingestMetaInbound(...)` e DESCARTAVA o retorno: um insert que falhava
   * virava `{"received": 1}` com nada gravado, e "chegou e falhou" ficava
   * indistinguível de "não chegou". Custou uma hora de diagnóstico no lugar errado.
   */
  const desfechos: string[] = [];

  for (const e of eventos) {
    // O evento chega carimbado com a WABA; se não for a desta sessão, ignoramos.
    // Confiar no `entry.id` para escolher a org seria aceitar o corpo como fonte.
    if (session.wabaId && e.wabaId && e.wabaId !== session.wabaId) continue;

    if (e.kind === "inbound_message") {
      // A metade que faltava: mensagem do contato vira linha no inbox, move lead,
      // acorda o agente — e carimba `last_inbound_at`, que é o que ABRE a janela
      // de 24h que o gate da Fase 4 calcula.
      // A organização vem do TOKEN DO PATH, nunca do corpo: é a mesma fonte que
      // decide onde os dois updates abaixo escrevem. Sem ela a ingestão
      // resolvia a sessão só pelo `phone_number_id` do payload — e duas
      // organizações com o mesmo número faziam a mensagem ser descartada para
      // as duas, com 200 na resposta (issue #236).
      const r = await ingestMetaInbound(admin, e, { organizationId: session.organizationId });
      desfechos.push(r.status);
      if (r.status === "failed" || r.status === "no_session") {
        // 2xx continua (a Meta re-entregaria em loop), mas a falha NÃO fica muda:
        // vai ao log estruturado e ao corpo da resposta.
        console.error("[meta.ingest] inbound não ingerido", {
          status: r.status,
          reason: r.status === "failed" ? r.reason : undefined,
          external_id: e.externalId,
          phone_number_id: e.phoneNumberId,
        });
      }
      continue;
    }

    if (e.kind === "outbound_echo") {
      // Coexistência: resposta dada pelo app WhatsApp Business. Entra na conversa
      // como saída de humano e pausa a IA — ver `ingestMetaEcho`. Mesma política
      // de falha da recebida: 2xx sempre, falha no log e no corpo.
      const r = await ingestMetaEcho(admin, e, { organizationId: session.organizationId });
      desfechos.push(`eco:${r.status}`);
      if (r.status === "failed" || r.status === "no_session") {
        logger.error("[meta.ingest] eco do app não ingerido", {
          request_id: requestId,
          status: r.status,
          reason: r.status === "failed" ? r.reason : undefined,
          external_id: e.externalId,
          phone_number_id: e.phoneNumberId,
        });
      }
      continue;
    }

    if (e.kind === "template_status") {
      await admin
        .from("meta_templates")
        .update({ status: e.event, rejected_reason: e.reason, updated_at: now })
        .eq("organization_id", session.organizationId)
        .eq("waba_id", e.wabaId)
        .eq("name", e.templateName)
        .eq("language", e.templateLanguage);
    } else if (e.status === "failed") {
      // A recusa da plataforma chega DEPOIS do 200 (131047 fora da janela,
      // 131026 número não registrado, 132015 template pausado). O evento inteiro
      // vira colunas como no ramo de baixo — e a falha emite `message.failed`
      // para quem integra (#1614), que até aqui não tinha gatilho nenhum.
      //
      // `.neq("status", "failed")` é o "uma vez": a Meta reentrega o mesmo
      // status enquanto não recebe 2xx, e cada reentegra seria mais um aviso
      // para o sistema do integrador sobre a MESMA falha. Só a primeira
      // atualiza uma linha, e só a primeira devolve linha — `linha` é o gatilho
      // da emissão, então 0 linhas = 0 eventos.
      const { data: linha } = await admin
        .from("messages")
        .update(statusUpdate(e, now))
        .eq("organization_id", session.organizationId)
        .eq("external_id", e.externalId)
        .neq("status", "failed")
        .select(
          "id, conversation_id, contact_id, sent_via, error_code, error_message, contacts:contact_id(phone_number)",
        )
        .maybeSingle();
      if (linha) {
        const falha = linha as {
          id: string;
          conversation_id: string | null;
          contact_id: string | null;
          sent_via: string | null;
          error_code: string | null;
          error_message: string | null;
          // FK de N para 1: o PostgREST devolve OBJETO em tempo de execução,
          // embora a tipagem gerada diga lista. `telefoneDoEmbed` aceita os dois.
          contacts: EmbedDoContato;
        };
        await emitirFalhaDeEntrega(admin, {
          organizationId: session.organizationId,
          source: "meta-status-webhook",
          requestId,
          falha: {
            message_id: falha.id,
            conversation_id: falha.conversation_id,
            contact_id: falha.contact_id,
            contact: telefoneDoEmbed(falha.contacts),
            sent_via: falha.sent_via,
            erro: { codigo: falha.error_code ?? "", titulo: falha.error_message },
          },
        });
      }
    } else {
      // O evento inteiro vira colunas, não só `status`: quando a Meta ACEITA o
      // template e reprova a entrega depois, o motivo só existe aqui. Ver
      // `lib/channels/meta/status-update.ts`.
      await admin
        .from("messages")
        .update(statusUpdate(e, now))
        .eq("organization_id", session.organizationId)
        .eq("external_id", e.externalId);
    }
  }

  // 200 SEMPRE que a assinatura confere, inclusive para evento que não nos
  // interessa: a Meta re-entrega tudo que não recebe 2xx, e recusar o que
  // ignoramos vira re-tentativa em backoff por horas.
  // `outcomes` no corpo: quem depura vê o que aconteceu com cada evento em vez de
  // ler um contador que não distingue sucesso de falha.
  return NextResponse.json(
    { received: eventos.length, outcomes: desfechos },
    { status: 200 },
  );
}
