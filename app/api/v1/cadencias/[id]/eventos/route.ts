/** Histórico real, por organização e cadência, com paginação estável. */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { cadenciasLigadas } from "@/lib/cadencias/modulo";
import { codificarPagina, lerPagina, paginaSchema } from "@/lib/cadencias/paginacao";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
export const dynamic = "force-dynamic";
const consultaSchema = paginaSchema.extend({ enrollment_id: z.uuid().optional() });
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "cadencias" });
  if (!authz.ok) return authz.response;
  if (!(await cadenciasLigadas(createAdminClient(), authz.org.orgId))) return fail("not_found", "Módulo indisponível.", 404, { requestId });
  const entrada = consultaSchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!entrada.success) return fail("validation_failed", "Query inválida.", 422, { requestId });
  const { limit, cursor, enrollment_id } = entrada.data;
  const depois = cursor ? lerPagina(cursor) : null;
  if (cursor && !depois) return fail("invalid_cursor", "Cursor inválido.", 400, { requestId });
  const { id } = await ctx.params;
  const supabase = await createClient();
  let query = supabase.from("email_cadence_events").select("id, enrollment_id, tipo, passo_id, created_at")
    .eq("organization_id", authz.org.orgId).eq("cadence_id", id)
    .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(limit + 1);
  if (enrollment_id) query = query.eq("enrollment_id", enrollment_id);
  if (depois) query = query.or(`created_at.lt.${depois.instante},and(created_at.eq.${depois.instante},id.lt.${depois.id})`);
  const { data, error } = await query;
  if (error) return fail("internal_error", "Não foi possível carregar os eventos.", 500, { requestId });
  const linhas = data ?? []; const temMais = linhas.length > limit; const resultado = linhas.slice(0, limit);
  const ultima = resultado.at(-1);
  return ok(resultado, { requestId, meta: { cursor: temMais && ultima ? codificarPagina(ultima.created_at, ultima.id) : null, has_more: temMais } });
}
