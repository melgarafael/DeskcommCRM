import { randomUUID, timingSafeEqual } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const headersSchema = z.object({
  organizationId: z.string().uuid(),
  empresaCodigo: z.coerce.number().int().positive(),
});
const querySchema = z.object({
  status: z.enum(["open", "won", "lost"]).optional(),
  pipelineId: z.string().uuid().optional(),
  updatedSince: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

function segredoValido(recebido: string | null): boolean {
  const esperado = process.env.ADVOMAX_CRM_INTEGRATION_KEY?.trim();
  if (!esperado || !recebido) return false;
  const a = Buffer.from(recebido);
  const b = Buffer.from(esperado);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!segredoValido(req.headers.get("X-CRM-Integration-Key"))) {
    return fail("unauthorized", "Credencial de integração inválida.", 401, { requestId });
  }

  const headers = headersSchema.safeParse({
    organizationId: req.headers.get("X-CRM-Organization-Id"),
    empresaCodigo: req.headers.get("X-Advomax-Empresa-Codigo"),
  });
  const query = querySchema.safeParse({
    status: req.nextUrl.searchParams.get("status") || undefined,
    pipelineId: req.nextUrl.searchParams.get("pipeline_id") || undefined,
    updatedSince: req.nextUrl.searchParams.get("updated_since") || undefined,
    limit: req.nextUrl.searchParams.get("limit") || undefined,
    offset: req.nextUrl.searchParams.get("offset") || undefined,
  });
  if (!headers.success || !query.success) {
    return fail("validation_failed", "Escopo ou filtros inválidos.", 422, { requestId });
  }

  const admin = createAdminClient();
  const { data: organization, error: organizationError } = await admin
    .from("organizations" as never)
    .select("id")
    .eq("id", headers.data.organizationId)
    .eq("status", "active")
    .eq("advomax_empresa_codigo", headers.data.empresaCodigo)
    .maybeSingle();
  if (organizationError) return fail("internal_error", "Não foi possível validar o escritório.", 500, { requestId });
  if (!organization) return fail("forbidden", "Escritório sem vínculo ativo com o Advomax.", 403, { requestId });

  const orgId = headers.data.organizationId;
  let leadsQuery = admin
    .from("crm_leads")
    .select("id,title,status,pipeline_id,stage_id,contact_id,value_cents,currency,expected_close_date,last_activity_at,created_at,updated_at")
    .eq("organization_id", orgId)
    .order("updated_at", { ascending: false })
    .order("id", { ascending: false })
    .range(query.data.offset, query.data.offset + query.data.limit);
  if (query.data.status) leadsQuery = leadsQuery.eq("status", query.data.status);
  if (query.data.pipelineId) leadsQuery = leadsQuery.eq("pipeline_id", query.data.pipelineId);
  if (query.data.updatedSince) leadsQuery = leadsQuery.gte("updated_at", query.data.updatedSince);

  const [pipelinesResult, stagesResult, leadsResult] = await Promise.all([
    admin.from("crm_pipelines").select("id,name,slug,position,is_default,updated_at").eq("organization_id", orgId).eq("is_archived", false).order("position"),
    admin.from("crm_stages").select("id,pipeline_id,name,slug,position,color,is_won,is_lost,updated_at").eq("organization_id", orgId).eq("is_archived", false).order("position"),
    leadsQuery,
  ]);
  if (pipelinesResult.error || stagesResult.error || leadsResult.error) {
    return fail("internal_error", "Não foi possível consultar a carteira comercial.", 500, { requestId });
  }

  const hasMore = (leadsResult.data?.length ?? 0) > query.data.limit;
  const leads = (leadsResult.data ?? []).slice(0, query.data.limit);
  const contactIds = [...new Set(leads.map((lead) => lead.contact_id).filter((id): id is string => typeof id === "string"))];
  const [contactsResult, linksResult] = contactIds.length
    ? await Promise.all([
        admin.from("contacts").select("id,name,display_name,email,phone_number").eq("organization_id", orgId).in("id", contactIds),
        admin.from("advomax_contact_links" as never).select("contact_id,pessoa_codigo").eq("organization_id", orgId).eq("status", "linked").in("contact_id", contactIds),
      ])
    : [{ data: [], error: null }, { data: [], error: null }];
  if (contactsResult.error || linksResult.error) {
    return fail("internal_error", "Não foi possível consultar os clientes da carteira.", 500, { requestId });
  }

  const contacts = new Map((contactsResult.data ?? []).map((contact) => [contact.id, contact]));
  const pessoaPorContato = new Map(
    ((linksResult.data ?? []) as unknown as Array<{ contact_id: string; pessoa_codigo: number }>).map((link) => [link.contact_id, link.pessoa_codigo]),
  );

  const response = ok({
    pipelines: pipelinesResult.data ?? [],
    stages: stagesResult.data ?? [],
    has_more: hasMore,
    next_offset: hasMore ? query.data.offset + query.data.limit : null,
    opportunities: leads.map((lead) => {
      const contact = lead.contact_id ? contacts.get(lead.contact_id) : null;
      return {
        id: lead.id,
        title: lead.title,
        status: lead.status,
        pipeline_id: lead.pipeline_id,
        stage_id: lead.stage_id,
        value_cents: lead.value_cents,
        currency: lead.currency,
        expected_close_date: lead.expected_close_date,
        last_activity_at: lead.last_activity_at,
        created_at: lead.created_at,
        updated_at: lead.updated_at,
        contact: contact ? {
          id: contact.id,
          name: contact.display_name || contact.name,
          email: contact.email,
          phone: contact.phone_number,
          pessoa_codigo: pessoaPorContato.get(contact.id) ?? null,
        } : null,
      };
    }),
  }, { requestId });
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
