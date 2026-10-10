/**
 * GET|POST /api/v1/webhooks/instagram-comments/[token]
 *
 * Webhook da Instagram Graph API para comentários em posts e reels.
 *
 * ── GET (handshake) ────────────────────────────────────────────────────────
 * A Meta verifica o endpoint antes de ativar a assinatura. Retorna o
 * `hub.challenge` em texto puro — NUNCA no wrapper JSON padrão, senão a
 * verificação falha silenciosamente.
 *
 * ── POST (entrega de evento) ───────────────────────────────────────────────
 * Verifica HMAC-SHA256 com o App Secret da instalação (`platform_meta_app`,
 * mesma credencial do WhatsApp Cloud API). O `[token]` na URL resolve a
 * organização via `ig_webhook_tokens.path_token` — sem ele, qualquer um com
 * o App Secret poderia escrever em qualquer tenant.
 *
 * Depois de verificar, grava em `ig_comment_events` (idempotente) e emite
 * `ig.comment_received` no `event_log`. O worker de automação consome
 * assincronamente — NUNCA fazemos HTTP na entrega do webhook.
 *
 * ── Segurança ──────────────────────────────────────────────────────────────
 * - organization_id: resolvido do BANCO via path_token (fonte confiável)
 *   — nunca do body do webhook.
 * - HMAC: verificado ANTES de qualquer escrita no banco.
 * - Timing safe: usa `timingSafeEqual` para comparar assinaturas.
 */
import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

import { fail } from "@/lib/api/wrappers";
import { createAdminClient } from "@/lib/supabase/admin";
import { appDaMeta } from "@/lib/channels/meta/app";
import { parseIgWebhookPayload, verifyIgWebhookSignature } from "@/lib/channels/instagram/comment-parser";
import { ingestIgComment } from "@/lib/channels/instagram/comment-ingest";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteCtx {
  params: Promise<{ token: string }>;
}

// ── GET — handshake de verificação da Meta ────────────────────────────────────

export async function GET(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const { token } = await ctx.params;

  const db = createAdminClient();

  // Resolve o token no banco
  const { data: tokenRow, error } = await db.rpc("fn_ig_webhook_token_por_path", {
    p_path_token: token,
  });

  if (error || !tokenRow || (Array.isArray(tokenRow) && tokenRow.length === 0)) {
    return new NextResponse("not found", { status: 404 });
  }

  const row = Array.isArray(tokenRow) ? tokenRow[0] : tokenRow;
  if (!row.ativo) return new NextResponse("token inactive", { status: 404 });

  const params = req.nextUrl.searchParams;
  const mode      = params.get("hub.mode");
  const challenge = params.get("hub.challenge");
  const verifyTok = params.get("hub.verify_token");

  if (mode !== "subscribe") {
    return new NextResponse("invalid mode", { status: 400 });
  }

  // Compara com o verify_token armazenado no banco para esta org
  if (verifyTok !== row.verify_token) {
    return new NextResponse("forbidden", { status: 403 });
  }

  if (!challenge) return new NextResponse("missing challenge", { status: 400 });

  // Texto puro — o wrapper JSON faz a verificação da Meta falhar
  return new NextResponse(challenge, {
    status: 200,
    headers: { "content-type": "text/plain" },
  });
}

// ── POST — entrega de eventos de comentário ───────────────────────────────────

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const requestId = randomUUID();
  const { token } = await ctx.params;

  const db = createAdminClient();

  // 1. Resolver o token → organization_id (antes de qualquer body parse)
  const { data: tokenRow, error: tokenError } = await db.rpc("fn_ig_webhook_token_por_path", {
    p_path_token: token,
  });

  if (tokenError || !tokenRow || (Array.isArray(tokenRow) && tokenRow.length === 0)) {
    return fail("not_found", "unknown webhook token", 404, { requestId });
  }

  const row = Array.isArray(tokenRow) ? tokenRow[0] : tokenRow;
  if (!row.ativo) {
    return fail("not_found", "token inactive", 404, { requestId });
  }

  const organizationId: string = row.organization_id;

  // 2. Ler body RAW — necessário para verificar HMAC ANTES de parsear JSON
  let bodyRaw: string;
  try {
    bodyRaw = await req.text();
  } catch {
    return fail("bad_request", "could not read body", 400, { requestId });
  }

  // 3. Verificar HMAC-SHA256 com o App Secret da instalação
  const signature = req.headers.get("x-hub-signature-256") ?? "";

  const { appSecret } = await appDaMeta();

  if (!appSecret) {
    logger.error("[ig-comments-webhook] meta app secret not configured", { requestId });
    return fail("internal_error", "meta app not configured", 500, { requestId });
  }

  const valid = await verifyIgWebhookSignature(bodyRaw, signature, appSecret);
  if (!valid) {
    logger.warn("[ig-comments-webhook] invalid signature", {
      requestId,
      organizationId,
      token: token.slice(0, 8) + "…",
    });
    return fail("forbidden", "invalid signature", 403, { requestId });
  }

  // 4. Parsear payload
  let payload: unknown;
  try {
    payload = JSON.parse(bodyRaw);
  } catch {
    return fail("bad_request", "invalid json", 400, { requestId });
  }

  // 5. Extrair eventos de comentário
  const events = parseIgWebhookPayload(payload, row.ig_business_account_id ?? undefined);

  if (events.length === 0) {
    // Payload sem comentários (ex: stories, mentions sem comentário) → 200 silencioso
    return new NextResponse(null, { status: 200 });
  }

  // 6. Ingerir cada comentário
  const results = await Promise.allSettled(
    events.map((event) =>
      ingestIgComment(db, {
        organizationId,
        channelSessionId: row.channel_session_id ?? null,
        event,
        payloadRaw: payload as Record<string, unknown>,
      }),
    ),
  );

  const inserted = results.filter(
    (r) => r.status === "fulfilled" && r.value.status === "inserted",
  ).length;

  const duplicates = results.filter(
    (r) => r.status === "fulfilled" && (r.value as { status: string }).status === "duplicate",
  ).length;

  logger.info("[ig-comments-webhook] processed", {
    requestId,
    organizationId,
    total: events.length,
    inserted,
    duplicates,
  });

  return new NextResponse(null, { status: 200 });
}
