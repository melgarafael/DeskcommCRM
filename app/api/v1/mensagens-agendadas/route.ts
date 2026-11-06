/**
 * GET  /api/v1/mensagens-agendadas?contact_id=…  — agendamentos pendentes do contato (ou da organização).
 * POST /api/v1/mensagens-agendadas               — cria uma mensagem de texto agendada para um contato.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { audit } from "@/lib/audit";
import { ok, fail } from "@/lib/api/wrappers";
import { createAdminClient } from "@/lib/supabase/admin";
import { criarAgendamentoSchema, motivoRegraInvalida, regraDoCorpo } from "@/lib/agendamento-mensagem/schema";
import { primeiraOcorrencia } from "@/lib/agendamento-mensagem/recorrencia";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const auth = await requireRole("agent", { requestId, resource: "mensagens_agendadas" });
  if (!auth.ok) return auth.response;
  const contactId = req.nextUrl.searchParams.get("contact_id");
  if (contactId && !z.uuid().safeParse(contactId).success) {
    return fail("validation_failed", "contact_id inválido.", 422, { requestId });
  }
  let q = createAdminClient()
    .from("mensagens_agendadas")
    .select("id, contact_id, channel_session_id, title, body, recorrencia, intervalo_dias, inicio_local, termino_local, tz, scheduled_at, status, se_desconectado, ultimo_erro, created_at, contacts(display_name, name)")
    .eq("organization_id", auth.org.orgId)
    .eq("status", "agendada")
    .order("scheduled_at", { ascending: true })
    .limit(200);
  if (contactId) q = q.eq("contact_id", contactId);
  const { data, error } = await q;
  if (error) return fail("internal_error", "Erro ao listar agendamentos.", 500, { requestId });
  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const denied = await requireSupportWrite();
  if (denied) return denied;
  const requestId = randomUUID();
  const auth = await requireRole("agent", { requestId, resource: "mensagens_agendadas" });
  if (!auth.ok) return auth.response;

  const parsed = criarAgendamentoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Confira os campos do agendamento.", 422, {
      requestId,
      details: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  const v = parsed.data;
  const orgId = auth.org.orgId;

  const regra = regraDoCorpo(v);
  const motivo = motivoRegraInvalida(regra);
  if (motivo) return fail("validation_failed", "Confira a recorrência e as datas.", 422, { requestId, details: { motivo } });

  const admin = createAdminClient();
  const [{ data: contato }, { data: sessao }] = await Promise.all([
    admin.from("contacts").select("id").eq("id", v.contact_id).eq("organization_id", orgId).maybeSingle(),
    admin.from("channel_sessions").select("id").eq("id", v.channel_session_id).eq("organization_id", orgId).maybeSingle(),
  ]);
  if (!contato || !sessao) return fail("not_found", "Contato ou número não encontrado.", 404, { requestId });

  const { data: criado, error } = await admin
    .from("mensagens_agendadas")
    .insert({
      organization_id: orgId,
      contact_id: v.contact_id,
      channel_session_id: v.channel_session_id,
      title: v.title ?? null,
      body: v.body,
      recorrencia: v.recorrencia,
      intervalo_dias: v.intervalo_dias ?? null,
      inicio_local: v.inicio_local,
      termino_local: v.termino_local ?? null,
      tz: v.tz,
      scheduled_at: primeiraOcorrencia(regra).toISOString(),
      se_desconectado: v.se_desconectado,
      created_by_user_id: auth.user.id,
    })
    .select("id, scheduled_at, status")
    .single();
  if (error || !criado) return fail("internal_error", "Não consegui criar o agendamento.", 500, { requestId });

  void audit({
    action: "scheduled_message.created",
    organizationId: orgId,
    actorUserId: auth.user.id,
    resourceType: "mensagens_agendadas",
    resourceId: criado.id,
    requestId,
    metadata: { recorrencia: v.recorrencia },
  });
  return ok(criado, { requestId });
}
