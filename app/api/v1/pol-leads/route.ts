/**
 * GET|POST /api/v1/pol-leads
 *
 * CRUD de leads politicos — extensao politica de contacts.
 *
 * GET  — lista pol_leads da organizacao. Aceita ?support_level=, ?temperature=, ?territory_id=.
 *        Junta nome do contato via contacts. Paginacao com limit/offset.
 * POST — cria um novo pol_lead. Requer role manager.
 *
 * Seguranca: organizacao resolvida do cookie/JWT (fonte confiavel). Nunca do body.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { NextResponse, type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireSupportWrite } from "@/lib/impersonate/support";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// -- Validacao ----------------------------------------------------------------

const SUPPORT_LEVELS = [
  "novo_cadastro",
  "simpatizante",
  "apoiador",
  "militante",
  "voto_certo",
] as const;

const TEMPERATURES = ["frio", "morno", "quente"] as const;

const criarPolLeadSchema = z.object({
  contact_id: z.string().uuid(),
  support_level: z.enum(SUPPORT_LEVELS).default("novo_cadastro"),
  temperature: z.enum(TEMPERATURES).default("frio"),
  zona_eleitoral: z.string().max(20).nullable().optional(),
  secao_eleitoral: z.string().max(20).nullable().optional(),
  mobilizer_id: z.string().uuid().nullable().optional(),
  leader_potential: z.boolean().default(false),
  community_role: z.string().max(120).nullable().optional(),
  territory_id: z.string().uuid().nullable().optional(),
  consent_origin: z.string().max(120).nullable().optional(),
});

// -- GET — listar pol_leads ---------------------------------------------------

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  const authz = await requireRole("viewer", { requestId, resource: "pol_leads" });
  if (!authz.ok) return authz.response;

  const { organizationId } = authz;
  const db = createAdminClient();
  const params = req.nextUrl.searchParams;

  let query = db
    .from("pol_leads")
    .select(
      "id, contact_id, support_level, political_score, temperature, zona_eleitoral, secao_eleitoral, mobilizer_id, leader_potential, community_role, territory_id, opt_out, consent_origin, consent_at, created_at, updated_at, contacts(id, name, phone, email)",
    )
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false });

  // Filtros opcionais
  const supportLevel = params.get("support_level");
  if (supportLevel) query = query.eq("support_level", supportLevel);

  const temperature = params.get("temperature");
  if (temperature) query = query.eq("temperature", temperature);

  const territoryId = params.get("territory_id");
  if (territoryId) query = query.eq("territory_id", territoryId);

  // Paginacao simples
  const limit = Math.min(parseInt(params.get("limit") ?? "50", 10), 100);
  const offset = parseInt(params.get("offset") ?? "0", 10);
  query = query.range(offset, offset + limit - 1);

  const { data, error, count } = await query;

  if (error) {
    return fail("internal_error", "Erro ao buscar pol_leads", 500, { requestId });
  }

  return ok(
    { pol_leads: data ?? [] },
    {
      headers: { "x-request-id": requestId },
      meta: { total: count ?? (data?.length ?? 0), limit, offset },
    },
  );
}

// -- POST — criar pol_lead ----------------------------------------------------

export async function POST(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  const authz = await requireRole("manager", { requestId, resource: "pol_leads" });
  if (!authz.ok) return authz.response;

  const { organizationId, userId } = authz;

  const guardaSuporteWrite = await requireSupportWrite({ requestId, resource: "pol_leads.create" });
  if (!guardaSuporteWrite.ok) return guardaSuporteWrite.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("bad_request", "JSON invalido", 400, { requestId });
  }

  const parsed = criarPolLeadSchema.safeParse(body);
  if (!parsed.success) {
    return fail("validation_error", "Dados invalidos", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const db = createAdminClient();

  // Verificar se contact_id existe e pertence a organizacao
  const { data: contact, error: errContact } = await db
    .from("contacts")
    .select("id")
    .eq("id", parsed.data.contact_id)
    .eq("organization_id", organizationId)
    .single();

  if (errContact || !contact) {
    return fail("not_found", "Contato nao encontrado nesta organizacao", 404, { requestId });
  }

  const { data: polLead, error } = await db
    .from("pol_leads")
    .insert({
      organization_id: organizationId,
      contact_id: parsed.data.contact_id,
      support_level: parsed.data.support_level,
      temperature: parsed.data.temperature,
      zona_eleitoral: parsed.data.zona_eleitoral ?? null,
      secao_eleitoral: parsed.data.secao_eleitoral ?? null,
      mobilizer_id: parsed.data.mobilizer_id ?? null,
      leader_potential: parsed.data.leader_potential,
      community_role: parsed.data.community_role ?? null,
      territory_id: parsed.data.territory_id ?? null,
      consent_origin: parsed.data.consent_origin ?? null,
    })
    .select()
    .single();

  if (error) {
    // Duplicate contact+org constraint
    if (error.code === "23505") {
      return fail("conflict", "Este contato ja possui um registro pol_lead nesta organizacao", 409, {
        requestId,
      });
    }
    return fail("internal_error", "Erro ao criar pol_lead", 500, { requestId });
  }

  // Audit log
  await db.from("api_audit_log").insert({
    organization_id: organizationId,
    user_id: userId,
    action: "pol_leads.create",
    resource_id: polLead.id,
    metadata: { contact_id: polLead.contact_id, support_level: polLead.support_level },
  });

  return ok({ pol_lead: polLead }, { status: 201, headers: { "x-request-id": requestId } });
}
