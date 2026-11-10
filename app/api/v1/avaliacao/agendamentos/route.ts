import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { resolverContatoParaAgendamento } from "@/lib/avaliacao/resolver-contato";
import { MODULO_AVALIACAO_NAO_INSTALADO, moduloAvaliacaoNaoInstalado } from "@/lib/avaliacao/modulo";
import { criarAgendamentoSchema, listarAgendamentosSchema } from "@/lib/avaliacao/schemas";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const SELECT_LISTA =
  "id, contact_id, lead_id, unit_id, consultant_user_id, attendant_user_id, scheduled_at, duration_minutes, client_email, vehicle_plate, vehicle_brand, vehicle_model, notes, status, evaluation_started_at, cancelled_at, evaluated_at, created_at, contacts(name, phone_number, email), avaliacao_unidades(name)";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const admin = createAdminClient();
  if (!(await moduloLigado(admin, "avaliacao"))) {
    return fail("not_found", "Not found", 404, { requestId });
  }

  const authz = await requireRole("viewer", { requestId, resource: "avaliacao_agendamentos" });
  if (!authz.ok) return authz.response;

  const url = new URL(req.url);
  const parsed = listarAgendamentosSchema.safeParse({
    de: url.searchParams.get("de"),
    ate: url.searchParams.get("ate"),
    status: url.searchParams.get("status") ?? undefined,
    unit_id: url.searchParams.get("unit_id") ?? undefined,
    consultant_user_id: url.searchParams.get("consultant_user_id") ?? undefined,
    attendant_user_id: url.searchParams.get("attendant_user_id") ?? undefined,
    q: url.searchParams.get("q") ?? undefined,
  });
  if (!parsed.success) {
    return fail("validation_failed", parsed.error.issues[0]?.message ?? "filtros inválidos", 422, {
      requestId,
    });
  }

  const supabase = await createClient();
  let q = supabase
    .from("avaliacao_agendamentos")
    .select(SELECT_LISTA)
    .gte("scheduled_at", parsed.data.de)
    .lte("scheduled_at", parsed.data.ate)
    .order("scheduled_at", { ascending: true })
    .limit(500);

  if (parsed.data.status) q = q.eq("status", parsed.data.status);
  if (parsed.data.unit_id) q = q.eq("unit_id", parsed.data.unit_id);
  if (parsed.data.consultant_user_id) q = q.eq("consultant_user_id", parsed.data.consultant_user_id);
  if (parsed.data.attendant_user_id) q = q.eq("attendant_user_id", parsed.data.attendant_user_id);

  const { data, error } = await q;
  if (error) {
    if (moduloAvaliacaoNaoInstalado(error)) {
      return fail("module_not_installed", MODULO_AVALIACAO_NAO_INSTALADO, 409, { requestId });
    }
    return fail("internal_error", error.message, 500, { requestId });
  }

  let lista = data ?? [];
  const termo = parsed.data.q?.toLowerCase();
  if (termo) {
    lista = lista.filter((row) => {
      const c = row.contacts as { name?: string; phone_number?: string } | { name?: string; phone_number?: string }[] | null;
      const contato = Array.isArray(c) ? c[0] : c;
      const nome = contato?.name?.toLowerCase() ?? "";
      const placa = (row.vehicle_plate as string | null)?.toLowerCase() ?? "";
      const modelo = (row.vehicle_model as string | null)?.toLowerCase() ?? "";
      const marca = (row.vehicle_brand as string | null)?.toLowerCase() ?? "";
      return nome.includes(termo) || placa.includes(termo) || modelo.includes(termo) || marca.includes(termo);
    });
  }

  return ok(lista, { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const admin = createAdminClient();
  if (!(await moduloLigado(admin, "avaliacao"))) {
    return fail("not_found", "Not found", 404, { requestId });
  }

  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const authz = await requireRole("agent", { requestId, resource: "avaliacao_agendamentos" });
  if (!authz.ok) return authz.response;

  const body = criarAgendamentoSchema.safeParse(await req.json().catch(() => ({})));
  if (!body.success) {
    return fail("validation_failed", body.error.issues[0]?.message ?? "corpo inválido", 422, {
      requestId,
    });
  }

  const supabase = await createClient();
  const orgId = authz.org.orgId;

  let contactId: string;
  try {
    const resolvido = await resolverContatoParaAgendamento(supabase, orgId, body.data, authz.user.id);
    contactId = resolvido.contact_id;
  } catch (e) {
    const codigo = typeof e === "object" && e && "code" in e ? String((e as { code?: string }).code) : "";
    const msg =
      e instanceof Error
        ? e.message
        : typeof e === "object" && e && "message" in e
          ? String((e as { message?: string }).message)
          : "contato inválido";
    if (msg === "contact_not_found") {
      return fail("not_found", "Contato não encontrado nesta empresa.", 404, { requestId });
    }
    if (msg === "client_required") {
      return fail("validation_failed", "Informe nome e WhatsApp válidos (com DDD).", 422, { requestId });
    }
    if (codigo === "42501") {
      return fail("forbidden_role", "Sem permissão para criar contato. Peça a um gestor.", 403, { requestId });
    }
    return fail("validation_failed", msg, 422, { requestId });
  }

  let consultantId = body.data.consultant_user_id ?? null;
  if (body.data.consultant_auto || !consultantId) {
    const { data: autoId, error: autoErr } = await supabase.rpc("fn_avaliacao_resolver_consultor", {
      p_org: orgId,
      p_unit: body.data.unit_id,
    });
    if (!autoErr && autoId) consultantId = autoId as string;
  }

  const insert = {
    organization_id: orgId,
    contact_id: contactId,
    lead_id: body.data.lead_id ?? null,
    unit_id: body.data.unit_id,
    consultant_user_id: consultantId,
    attendant_user_id: body.data.attendant_user_id ?? null,
    scheduled_at: body.data.scheduled_at,
    duration_minutes: body.data.duration_minutes ?? 20,
    client_email: body.data.client_email || null,
    vehicle_plate: body.data.vehicle_plate ?? null,
    vehicle_brand: body.data.vehicle_brand ?? null,
    vehicle_model: body.data.vehicle_model ?? null,
    notes: body.data.notes ?? null,
    status: "agendado" as const,
  };

  const { data, error } = await supabase.from("avaliacao_agendamentos").insert(insert).select(SELECT_LISTA).single();
  if (error) {
    if (moduloAvaliacaoNaoInstalado(error)) {
      return fail("module_not_installed", MODULO_AVALIACAO_NAO_INSTALADO, 409, { requestId });
    }
    return fail("internal_error", error.message, 500, { requestId });
  }

  void audit({
    action: "avaliacao.agendamento_criado",
    resourceType: "avaliacao_agendamento",
    resourceId: data.id,
    organizationId: orgId,
    actorUserId: authz.user.id,
    metadata: { contact_id: contactId, unit_id: body.data.unit_id },
  });

  return ok(data, { requestId, status: 201 });
}
