/** Vínculos duráveis Contato CRM ↔ Processo Advomax; detalhes jurídicos seguem no Advomax. */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { advomaxProcessUrl } from "@/lib/advomax/navigation";
import { erroDeConflitoDeProcesso, processoConstaNoResumo, processoLinkBodySchema } from "@/lib/advomax/processo-links";
import { requireRole } from "@/lib/auth/require-role";
import { env } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
interface RouteCtx { params: Promise<{ id: string }> }

type ContactLink = { pessoa_codigo: number; status: string };

function ponteConfigurada(): boolean {
  return Boolean(env.ADVOMAX_API_URL.trim() && env.ADVOMAX_CRM_INTEGRATION_KEY.trim());
}

async function pessoaVinculada(contactId: string, organizationId: string) {
  const supabase = await createClient();
  const { data: contact, error: contactError } = await supabase
    .from("contacts").select("id").eq("id", contactId).eq("organization_id", organizationId).maybeSingle();
  if (contactError) return { supabase, error: fail("internal_error", "Não foi possível validar o contato.", 500), link: null };
  if (!contact) return { supabase, error: fail("not_found", "Contato não encontrado.", 404), link: null };
  const { data, error } = await supabase.from("advomax_contact_links" as never)
    .select("pessoa_codigo,status").eq("organization_id", organizationId).eq("contact_id", contactId).maybeSingle();
  if (error) return { supabase, error: fail("internal_error", "Não foi possível consultar o vínculo jurídico.", 500), link: null };
  const link = data as ContactLink | null;
  if (!link || link.status !== "linked") {
    return { supabase, error: fail("conflict", "Vincule e confirme o cadastro jurídico antes de relacionar processos.", 409), link: null };
  }
  return { supabase, error: null, link };
}

function semPonte(requestId: string) {
  return fail("integration_unavailable", "A integração com o Advomax não está configurada; não é possível confirmar o processo jurídico.", 503, { requestId });
}

export async function GET(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "advomax_process_link" });
  if (!authz.ok) return authz.response;
  const { id } = await ctx.params;
  const scoped = await pessoaVinculada(id, authz.org.orgId);
  if (scoped.error) return scoped.error;
  const { data, error } = await scoped.supabase.from("advomax_contact_process_links" as never)
    .select("id,processo_codigo,created_at,created_by").eq("organization_id", authz.org.orgId).eq("contact_id", id)
    .order("created_at", { ascending: false });
  if (error) return fail("internal_error", "Não foi possível listar os vínculos de processo.", 500, { requestId });
  const links = (data as Array<{ processo_codigo: number }> | null ?? []).map((link) => ({
    ...link,
    advomax_url: ponteConfigurada() ? advomaxProcessUrl(link.processo_codigo) : null,
  }));
  return ok(links, { requestId });
}

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "advomax_process_link" });
  if (!authz.ok) return authz.response;
  const parsed = processoLinkBodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", "Informe um código de processo válido.", 422, { requestId });
  const { id } = await ctx.params;
  const scoped = await pessoaVinculada(id, authz.org.orgId);
  if (scoped.error) return scoped.error;
  if (!ponteConfigurada()) return semPonte(requestId);

  const base = env.ADVOMAX_API_URL.replace(/\/$/, "");
  const response = await fetch(`${base}/integracoes/crm/pessoas/${scoped.link!.pessoa_codigo}/processos`, {
    headers: {
      "X-CRM-Integration-Key": env.ADVOMAX_CRM_INTEGRATION_KEY,
      "X-CRM-User-Email": authz.user.email,
      "X-CRM-Organization-Id": authz.org.orgId,
    },
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!response?.ok) return fail("bad_gateway", "Não foi possível confirmar o processo no Advomax.", 502, { requestId });
  const body = await response.json().catch(() => null);
  if (!processoConstaNoResumo(body, parsed.data.processo_codigo)) {
    return fail("not_found", "O processo não está disponível para a Pessoa vinculada.", 404, { requestId });
  }

  const { data, error } = await scoped.supabase.from("advomax_contact_process_links" as never).insert({
    organization_id: authz.org.orgId, contact_id: id, processo_codigo: parsed.data.processo_codigo, created_by: authz.user.id,
  } as never).select("id,processo_codigo,created_at,created_by").single();
  if (erroDeConflitoDeProcesso(error)) return fail("conflict", "Este processo já está vinculado a este contato.", 409, { requestId });
  if (error) return fail("internal_error", "Não foi possível criar o vínculo de processo.", 500, { requestId });
  await audit({ action: "contact.advomax_process_linked", actorUserId: authz.user.id, organizationId: authz.org.orgId,
    resourceType: "advomax_contact_process_link", resourceId: (data as { id: string }).id, requestId,
    metadata: { contact_id: id, pessoa_codigo: scoped.link!.pessoa_codigo, processo_codigo: parsed.data.processo_codigo } });
  return ok({ ...(data as object), advomax_url: advomaxProcessUrl(parsed.data.processo_codigo) }, { status: 201, requestId });
}
