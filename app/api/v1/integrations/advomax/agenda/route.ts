import { randomUUID, timingSafeEqual } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const headerSchema = z.object({ organizationId: z.string().uuid(), empresaCodigo: z.coerce.number().int().positive() });
const querySchema = z.object({
  de: z.string().datetime({ offset: true }),
  ate: z.string().datetime({ offset: true }),
  limit: z.coerce.number().int().min(1).max(100).default(100),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
}).refine((query) => {
  const de = Date.parse(query.de);
  const ate = Date.parse(query.ate);
  return ate > de && ate - de <= 366 * 24 * 60 * 60 * 1000;
}, { message: "Período inválido." });

function segredoValido(recebido: string | null) {
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
  const headers = headerSchema.safeParse({
    organizationId: req.headers.get("X-CRM-Organization-Id"),
    empresaCodigo: req.headers.get("X-Advomax-Empresa-Codigo"),
  });
  const query = querySchema.safeParse({
    de: req.nextUrl.searchParams.get("de"), ate: req.nextUrl.searchParams.get("ate"),
    limit: req.nextUrl.searchParams.get("limit") || undefined,
    offset: req.nextUrl.searchParams.get("offset") || undefined,
  });
  if (!headers.success || !query.success) return fail("validation_failed", "Escopo ou período inválido.", 422, { requestId });

  const admin = createAdminClient();
  const { data: organization, error: orgError } = await admin.from("organizations" as never).select("id")
    .eq("id", headers.data.organizationId).eq("status", "active")
    .eq("advomax_empresa_codigo", headers.data.empresaCodigo).maybeSingle();
  if (orgError) return fail("internal_error", "Não foi possível validar o escritório.", 500, { requestId });
  if (!organization) return fail("forbidden", "Escritório sem vínculo ativo com o Advomax.", 403, { requestId });

  const orgId = headers.data.organizationId;
  const { data: page, error } = await admin.from("calendar_appointments")
    .select("id,title,starts_at,ends_at,time_zone,status,owner_user_id,contact_id,location_kind,location_details,revision,updated_at")
    .eq("organization_id", orgId).lt("starts_at", query.data.ate).gt("ends_at", query.data.de)
    .order("starts_at").order("id").range(query.data.offset, query.data.offset + query.data.limit);
  if (error) return fail("internal_error", "Não foi possível consultar os compromissos.", 500, { requestId });
  const hasMore = (page?.length ?? 0) > query.data.limit;
  const appointments = (page ?? []).slice(0, query.data.limit);
  const contactIds = [...new Set(appointments.map((item) => item.contact_id).filter((id): id is string => !!id))];
  const ownerIds = [...new Set(appointments.map((item) => item.owner_user_id).filter((id): id is string => !!id))];
  const links = contactIds.length
    ? await admin.from("advomax_contact_links" as never).select("contact_id,pessoa_codigo").eq("organization_id", orgId).eq("status", "linked").in("contact_id", contactIds)
    : { data: [], error: null };
  if (links.error) return fail("internal_error", "Não foi possível consultar os vínculos dos clientes.", 500, { requestId });
  const pessoaPorContato = new Map(((links.data ?? []) as unknown as Array<{ contact_id: string; pessoa_codigo: number }>).map((link) => [link.contact_id, link.pessoa_codigo]));
  const usuarioAdvomaxPorId = new Map<string, number>();
  for (const ownerId of ownerIds) {
    const user = await admin.auth.admin.getUserById(ownerId);
    const codigo = user.data.user?.app_metadata?.advomax_user_codigo;
    if (typeof codigo === "number" && Number.isSafeInteger(codigo) && codigo > 0) usuarioAdvomaxPorId.set(ownerId, codigo);
  }

  const response = ok({
    appointments: appointments.map((item) => ({
      id: item.id, title: item.title, starts_at: item.starts_at, ends_at: item.ends_at,
      time_zone: item.time_zone, status: item.status, location_kind: item.location_kind,
      location_details: item.location_details, revision: item.revision, updated_at: item.updated_at,
      pessoa_codigo: item.contact_id ? pessoaPorContato.get(item.contact_id) ?? null : null,
      usuario_codigo: item.owner_user_id ? usuarioAdvomaxPorId.get(item.owner_user_id) ?? null : null,
    })),
    has_more: hasMore,
    next_offset: hasMore ? query.data.offset + query.data.limit : null,
  }, { requestId });
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
