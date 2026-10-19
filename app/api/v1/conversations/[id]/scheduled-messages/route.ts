import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/conversations/[id]/scheduled-messages — lista pending da conversa.
 * POST /api/v1/conversations/[id]/scheduled-messages — agenda envio futuro.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { createScheduledMessageSchema } from "@/lib/schemas/scheduled-messages";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const COLS =
  "id, organization_id, conversation_id, created_by_user_id, send_at, status, body, type, media_url, media_storage_path, media_mime, media_size_bytes, metadata, reply_to_message_id, sent_message_id, last_error, created_at, updated_at";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, { params }: RouteParams): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "scheduled_messages" });
  if (!authz.ok) return authz.response;
  const { org } = authz;
  const { id: conversationId } = await params;

  const supabase = await createClient();
  const { data: conv } = await supabase
    .from("conversations")
    .select("id")
    .eq("id", conversationId)
    .eq("organization_id", org.orgId)
    .maybeSingle();
  if (!conv) return fail("not_found", "Conversa não encontrada.", 404, { requestId });

  const { data, error } = await supabase
    .from("scheduled_messages")
    .select(COLS)
    .eq("organization_id", org.orgId)
    .eq("conversation_id", conversationId)
    .eq("status", "pending")
    .order("send_at", { ascending: true });
  if (error) return fail("internal_error", "Erro ao listar agendamentos.", 500, { requestId });
  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest, { params }: RouteParams): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "scheduled_messages" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org } = authz;
  const { id: conversationId } = await params;

  const raw = await req.json().catch(() => null);
  const parsed = createScheduledMessageSchema.safeParse(raw);
  if (!parsed.success) {
    const flat = parsed.error.flatten();
    const primeira =
      flat.fieldErrors.send_at?.[0] ??
      flat.formErrors[0] ??
      t("Dados inválidos.");
    return fail("validation_failed", t(primeira), 422, {
      requestId,
      details: flat.fieldErrors as Record<string, unknown>,
    });
  }

  const supabase = await createClient();
  const { data: conv } = await supabase
    .from("conversations")
    .select("id")
    .eq("id", conversationId)
    .eq("organization_id", org.orgId)
    .maybeSingle();
  if (!conv) return fail("not_found", t("Conversa não encontrada."), 404, { requestId });

  const input = parsed.data;
  const metadata = {
    ...(input.metadata ?? {}),
    ...(input.atendimento_oculto ? { atendimento_oculto: true } : {}),
  };
  const { data, error } = await supabase
    .from("scheduled_messages")
    .insert({
      organization_id: org.orgId,
      conversation_id: conversationId,
      created_by_user_id: user.id,
      send_at: input.send_at,
      status: "pending",
      body: input.body ?? null,
      type: input.type,
      media_url: input.media_url ?? null,
      media_storage_path: input.media_storage_path ?? null,
      media_mime: input.media_mime ?? null,
      media_size_bytes: input.media_size_bytes ?? null,
      metadata: Object.keys(metadata).length > 0 ? metadata : null,
      reply_to_message_id: input.reply_to_message_id ?? null,
    })
    .select(COLS)
    .single();
  if (error || !data) {
    return fail("internal_error", "Erro ao agendar mensagem.", 500, { requestId });
  }

  void audit({
    action: "scheduled_message.created",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "scheduled_message",
    resourceId: data.id,
    requestId,
    metadata: { conversation_id: conversationId, send_at: input.send_at },
  });
  return ok(data, { requestId, status: 201 });
}
