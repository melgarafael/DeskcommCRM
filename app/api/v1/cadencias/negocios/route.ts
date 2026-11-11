/** Seleção real de negócios do tenant, sem expor UUIDs como formulário. */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { cadenciasLigadas } from "@/lib/cadencias/modulo";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
export const dynamic = "force-dynamic";
export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "cadencias" });
  if (!authz.ok) return authz.response;
  if (!(await cadenciasLigadas(createAdminClient(), authz.org.orgId))) return fail("not_found", "Módulo indisponível.", 404, { requestId });
  const termo = new URL(req.url).searchParams.get("q")?.trim().slice(0, 160) ?? "";
  const db = await createClient();
  let query = db.from("crm_leads").select("id, title, status").eq("organization_id", authz.org.orgId).order("updated_at", { ascending: false }).limit(20);
  if (termo) query = query.ilike("title", `%${termo.replace(/[%_\\]/g, "\\$&")}%`);
  const { data, error } = await query;
  if (error) return fail("internal_error", "Não foi possível buscar os negócios.", 500, { requestId });
  return ok(data ?? [], { requestId });
}
