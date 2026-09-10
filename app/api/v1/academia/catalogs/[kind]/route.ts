import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { requireAcademia } from "@/lib/modules/require-academia";
import { createClient } from "@/lib/supabase/server";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { catalogSchema, kindSchema, catalogColumns, type CatalogRecord } from "@/lib/academia/catalogs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ kind: string }> };
export async function GET(req: Request, context: Context) {
 const requestId = randomUUID();
 const auth = await requireAcademia(requestId); if (!auth.ok) return auth.response;
 const kind = kindSchema.safeParse((await context.params).kind);
 if (!kind.success) return fail("not_found", "Cadastro não encontrado.", 404, { requestId });
 const cursor = new URL(req.url).searchParams.get("cursor");
 if (cursor && !z.uuid().safeParse(cursor).success) return fail("validation_failed", "Página inválida.", 422, { requestId });
 let query = (await createClient()).from(`academia_${kind.data}`).select(catalogColumns(kind.data)).eq("organization_id", auth.org.orgId).order("id").limit(51);
 if (cursor) query = query.gt("id", cursor);
 const { data, error } = await query;
 if (error) return fail("internal_error", "Não foi possível carregar os cadastros.", 500, { requestId });
 const rows = (data ?? []) as unknown as CatalogRecord[];
 return ok(rows.slice(0,50), { requestId, headers: { "Cache-Control": "no-store" }, meta: { has_more: rows.length > 50, cursor: rows.length > 50 ? rows[49]!.id : null } });
}
async function write(req: Request, context: Context, create: boolean) {
 const requestId = randomUUID();
 const auth = await requireAcademia(requestId, "manager"); if (!auth.ok) return auth.response;
 const kind = kindSchema.safeParse((await context.params).kind);
 if (!kind.success) return fail("not_found", "Cadastro não encontrado.", 404, { requestId });
 const envelope = z.object({ id: z.uuid().optional(), revision: z.number().int().positive().optional(), values: z.unknown() }).strict().safeParse(await req.json().catch(() => null));
 if (!envelope.success) return fail("validation_failed", "Dados inválidos.", 422, { requestId });
 const parsed = catalogSchema(kind.data).safeParse(envelope.data.values);
 if (!parsed.success) return fail("validation_failed", parsed.error.issues[0]?.message ?? "Dados inválidos.", 422, { requestId });
 const id = create ? req.headers.get("Idempotency-Key") : envelope.data.id;
 if (!z.uuid().safeParse(id).success || (!create && !envelope.data.revision)) return fail("validation_failed", "Identificador ou revisão inválidos.", 422, { requestId });
 const db = await createClient(); const table = `academia_${kind.data}`;
 const query = create ? db.from(table).insert({ id, organization_id: auth.org.orgId, ...parsed.data }) : db.from(table).update(parsed.data).eq("organization_id", auth.org.orgId).eq("id", id).eq("revision", envelope.data.revision);
 const { data, error } = await query.select(catalogColumns(kind.data)).maybeSingle();
 if (error?.code === "23505" && create) {
   const { data: existing } = await db.from(table).select(catalogColumns(kind.data)).eq("organization_id", auth.org.orgId).eq("id", id).maybeSingle();
   const previous = existing as unknown as Record<string, unknown> | null;
   if (previous && Object.entries(parsed.data).every(([key, value]) => JSON.stringify(previous[key]) === JSON.stringify(value))) return ok(existing, { requestId });
 }
 if (error) return fail(error.code === "23505" ? "conflict" : error.code === "42501" ? "forbidden" : "internal_error", error.code === "23505" ? "Já existe um cadastro com esse nome ou identificador. Confira a lista antes de tentar novamente." : "Não foi possível salvar o cadastro.", error.code === "23505" ? 409 : error.code === "42501" ? 403 : 500, { requestId });
 if (!data) return fail("conflict", "Este cadastro mudou ou não está disponível. Atualize a lista antes de editar novamente.", 409, { requestId });
 await audit({ action: create ? "academia_catalog.created" : "academia_catalog.updated", organizationId: auth.org.orgId, actorUserId: auth.user.id, resourceType: table, resourceId: id, requestId, metadata: { kind: kind.data, active: parsed.data.active } });
 return ok(data, { requestId, status: create ? 201 : 200 });
}
export async function POST(req: Request, context: Context) { const denied = await requireSupportWrite(); if (denied) return denied; return write(req, context, true); }
export async function PATCH(req: Request, context: Context) { const denied = await requireSupportWrite(); if (denied) return denied; return write(req, context, false); }
