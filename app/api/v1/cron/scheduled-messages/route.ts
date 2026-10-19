/**
 * GET/POST /api/v1/cron/scheduled-messages — dispara pending com send_at vencido.
 *
 * Auth: Bearer INTERNAL_CRON_SECRET | INTERNAL_SECRET (fail-closed).
 * Agendado no scheduler a cada minuto.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { logger } from "@/lib/logger";
import { OrgNaoOperanteError } from "@/lib/organizacao/operante";
import { createAdminClient } from "@/lib/supabase/admin";
import type { SendMessageInput } from "@/lib/schemas/messaging";
import { sendMessageHandler } from "@/app/api/v1/messages/_handler";

export const dynamic = "force-dynamic";

const SCAN_LIMIT = 50;

interface DueRow {
  id: string;
  organization_id: string;
  conversation_id: string;
  created_by_user_id: string | null;
  body: string | null;
  type: string;
  media_url: string | null;
  media_storage_path: string | null;
  media_mime: string | null;
  media_size_bytes: number | null;
  metadata: Record<string, unknown> | null;
  reply_to_message_id: string | null;
}

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  const admin = createAdminClient();
  const nowIso = new Date().toISOString();

  const { data: due, error } = await admin
    .from("scheduled_messages")
    .select(
      "id, organization_id, conversation_id, created_by_user_id, body, type, media_url, media_storage_path, media_mime, media_size_bytes, metadata, reply_to_message_id",
    )
    .eq("status", "pending")
    .lte("send_at", nowIso)
    .order("send_at", { ascending: true })
    .limit(SCAN_LIMIT);

  if (error) {
    logger.error("[scheduled-messages] query failed", { error: error.message, requestId });
    return fail("internal_error", "Failed to query scheduled messages.", 500, { requestId });
  }

  const rows = (due ?? []) as DueRow[];
  let enviados = 0;
  let falhas = 0;

  for (const row of rows) {
    // Reserva atômica: pending → processing; só um tick processa.
    const { data: claimed } = await admin
      .from("scheduled_messages")
      .update({ status: "processing", updated_at: new Date().toISOString() })
      .eq("id", row.id)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();
    if (!claimed) continue;

    const input: SendMessageInput = {
      conversation_id: row.conversation_id,
      type: row.type as SendMessageInput["type"],
      body: row.body ?? undefined,
      media_url: row.media_url ?? undefined,
      media_storage_path: row.media_storage_path ?? undefined,
      media_mime: row.media_mime ?? undefined,
      media_size_bytes: row.media_size_bytes ?? undefined,
      metadata: row.metadata ?? undefined,
      reply_to_message_id: row.reply_to_message_id ?? undefined,
    };

    try {
      const msg = await sendMessageHandler(
        admin,
        {
          organization_id: row.organization_id,
          actor: {
            type: "webhook_source",
            id: row.created_by_user_id ?? row.id,
          },
          requestId: `scheduled-messages:${row.id}`,
        },
        input,
      );
      await admin
        .from("scheduled_messages")
        .update({
          status: "sent",
          sent_message_id: msg.id,
          last_error: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id);

      // Atendimento oculto: conversa fica pending até o contato responder.
      const meta = row.metadata as { atendimento_oculto?: boolean } | null;
      if (meta?.atendimento_oculto) {
        await admin
          .from("conversations")
          .update({ status: "pending", updated_at: new Date().toISOString() })
          .eq("id", row.conversation_id)
          .eq("organization_id", row.organization_id);
      }
      enviados += 1;
      void audit({
        action: "scheduled_message.sent",
        actorUserId: row.created_by_user_id,
        organizationId: row.organization_id,
        resourceType: "scheduled_message",
        resourceId: row.id,
        requestId,
        metadata: { message_id: msg.id },
      });
    } catch (err) {
      const mensagem = err instanceof Error ? err.message : String(err);
      const terminal = err instanceof OrgNaoOperanteError;
      await admin
        .from("scheduled_messages")
        .update({
          status: "failed",
          last_error: mensagem.slice(0, 500),
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id);
      falhas += 1;
      logger.error("[scheduled-messages] envio falhou", {
        id: row.id,
        error: mensagem,
        terminal,
        requestId,
      });
      void audit({
        action: "scheduled_message.failed",
        actorUserId: row.created_by_user_id,
        organizationId: row.organization_id,
        resourceType: "scheduled_message",
        resourceId: row.id,
        requestId,
        metadata: { error: mensagem.slice(0, 200) },
      });
    }
  }

  if (enviados > 0 || falhas > 0) {
    // audit agregado só quando houve efeito — padrão dos outros crons
  }

  return ok({ processed: rows.length, sent: enviados, failed: falhas }, { requestId });
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}
export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
