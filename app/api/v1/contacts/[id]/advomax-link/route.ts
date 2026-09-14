/** GET/POST/DELETE /api/v1/contacts/[id]/advomax-link. */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { requireRole } from "@/lib/auth/require-role";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
interface RouteCtx { params: Promise<{ id: string }> }
const bodySchema = z.object({ pessoa_codigo: z.coerce.number().int().positive() }).strict();

async function contactScope(id: string, organizationId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase.from("contacts").select("id").eq("id", id).eq("organization_id", organizationId).maybeSingle();
  if (error) return { supabase, error: fail("internal_error", "Não foi possível validar o contato.", 500) };
  if (!data) return { supabase, error: fail("not_found", "Contato não encontrado.", 404) };
  return { supabase, error: null };
}

export async function GET(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "advomax_contact_link" });
  if (!authz.ok) return authz.response;
  const { id } = await ctx.params;
  const scoped = await contactScope(id, authz.org.orgId);
  if (scoped.error) return scoped.error;
  const { data, error } = await scoped.supabase.from("advomax_contact_links" as never).select("*").eq("organization_id", authz.org.orgId).eq("contact_id", id).maybeSingle();
  if (error) return fail("internal_error", "Não foi possível consultar o vínculo.", 500, { requestId });
  return ok(data, { requestId });
}

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "advomax_contact_link" });
  if (!authz.ok) return authz.response;
  const { id } = await ctx.params;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", "Informe uma Pessoa válida.", 422, { requestId });
  const scoped = await contactScope(id, authz.org.orgId);
  if (scoped.error) return scoped.error;
  const { data, error } = await scoped.supabase.from("advomax_contact_links" as never).upsert({
    organization_id: authz.org.orgId,
    contact_id: id,
    pessoa_codigo: parsed.data.pessoa_codigo,
    status: "pending",
    authority_source: "advomax",
    created_by: authz.user.id,
  } as never, { onConflict: "organization_id,contact_id" }).select("*").single();
  if (error) {
    if (error.code === "23505") return fail("conflict", "Esta Pessoa já está vinculada a outro contato deste escritório.", 409, { requestId });
    return fail("internal_error", "Não foi possível criar o vínculo.", 500, { requestId });
  }
  await audit({ action: "contact.advomax_linked", actorUserId: authz.user.id, organizationId: authz.org.orgId, resourceType: "advomax_contact_link", resourceId: (data as { id: string }).id, requestId, metadata: { contact_id: id, pessoa_codigo: parsed.data.pessoa_codigo, status: "pending" } });
  return ok(data, { requestId });
}

export async function DELETE(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "advomax_contact_link" });
  if (!authz.ok) return authz.response;
  const { id } = await ctx.params;
  const scoped = await contactScope(id, authz.org.orgId);
  if (scoped.error) return scoped.error;
  const { data, error } = await scoped.supabase.from("advomax_contact_links" as never).update({ status: "unlinked", authority_epoch: 1 } as never).eq("organization_id", authz.org.orgId).eq("contact_id", id).select("*").maybeSingle();
  if (error) return fail("internal_error", "Não foi possível desfazer o vínculo.", 500, { requestId });
  await audit({ action: "contact.advomax_unlinked", actorUserId: authz.user.id, organizationId: authz.org.orgId, resourceType: "advomax_contact_link", resourceId: data ? (data as { id: string }).id : null, requestId, metadata: { contact_id: id } });
  return ok(data, { requestId });
}
