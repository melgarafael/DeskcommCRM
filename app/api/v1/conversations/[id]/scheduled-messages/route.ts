import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { canalAceitaTextoLivreAgora } from "@/lib/channels/janela";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

const entrada = z.strictObject({
  id: z.string().uuid(),
  body: z.string().trim().min(1).max(4000),
  scheduled_at: z.string().datetime({ offset: true }),
});

async function conversaVisivel(id: string, organizationId: string) {
  const db = await createClient();
  const { data, error } = await db
    .from("conversations")
    .select("id, status, last_inbound_at, channel_sessions:channel_session_id(provider)")
    .eq("organization_id", organizationId)
    .eq("id", id)
    .maybeSingle();
  return error ? null : data;
}

export async function GET(_req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "scheduled_messages" });
  if (!authz.ok) return authz.response;
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success)
    return fail("validation_error", "Conversa inválida.", 422, { requestId });
  if (!(await conversaVisivel(id, authz.org.orgId)))
    return fail("not_found", "Conversa não encontrada.", 404, { requestId });

  const db = await createClient();
  const { data, error } = await db
    .from("scheduled_messages")
    .select("*")
    .eq("organization_id", authz.org.orgId)
    .eq("conversation_id", id)
    .in("status", ["pending", "sending", "failed"])
    .order("status", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(100);
  if (error)
    return fail("internal_error", "Não foi possível carregar os agendamentos.", 500, { requestId });
  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "scheduled_messages" });
  if (!authz.ok) return authz.response;
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success)
    return fail("validation_error", "Conversa inválida.", 422, { requestId });
  const conversa = await conversaVisivel(id, authz.org.orgId);
  if (!conversa) return fail("not_found", "Conversa não encontrada.", 404, { requestId });
  if (conversa.status === "closed")
    return fail("conversation_closed", "Reabra a conversa antes de agendar.", 409, { requestId });

  const parsed = entrada.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return fail("validation_error", "Informe uma mensagem e um horário válidos.", 422, {
      requestId,
    });
  const quando = new Date(parsed.data.scheduled_at);
  const admin = createAdminClient();
  const buscarExistente = async () => {
    const { data } = await admin
      .from("scheduled_messages")
      .select("*")
      .eq("id", parsed.data.id)
      .eq("organization_id", authz.org.orgId)
      .eq("conversation_id", id)
      .eq("created_by_user_id", authz.user.id)
      .maybeSingle();
    return data?.body === parsed.data.body && data.scheduled_at === quando.toISOString()
      ? data
      : null;
  };
  const existente = await buscarExistente();
  if (existente) return ok(existente, { requestId });
  const distancia = quando.getTime() - Date.now();
  if (distancia < 60_000 || distancia > 365 * 24 * 60 * 60_000) {
    return fail(
      "invalid_schedule",
      "Escolha um horário entre 1 minuto e 365 dias a partir de agora.",
      422,
      { requestId },
    );
  }
  const sessao = conversa.channel_sessions as unknown as { provider: string } | null;
  if (!canalAceitaTextoLivreAgora(sessao?.provider, conversa.last_inbound_at, quando)) {
    return fail(
      "window_will_close",
      "Nesse horário a janela de 24 horas estará fechada. Escolha um horário anterior ou use um modelo aprovado.",
      422,
      { requestId },
    );
  }
  const { data, error } = await admin
    .from("scheduled_messages")
    .insert({
      id: parsed.data.id,
      organization_id: authz.org.orgId,
      conversation_id: id,
      created_by_user_id: authz.user.id,
      body: parsed.data.body,
      scheduled_at: quando.toISOString(),
    })
    .select("*")
    .single();
  if (error?.code === "23505") {
    const criadoEmParalelo = await buscarExistente();
    if (criadoEmParalelo) return ok(criadoEmParalelo, { requestId });
    return fail("duplicate_schedule", "Esse agendamento já existe.", 409, { requestId });
  }
  if (error || !data)
    return fail("internal_error", "Não foi possível agendar a mensagem.", 500, { requestId });
  void audit({
    action: "message.scheduled",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "scheduled_message",
    resourceId: data.id,
    requestId,
    metadata: { conversation_id: id, scheduled_at: data.scheduled_at },
  });
  return ok(data, { requestId, status: 201 });
}
