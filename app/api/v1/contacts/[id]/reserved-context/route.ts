import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { ok, fail } from "@/lib/api/wrappers";
export const dynamic = "force-dynamic";
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const auth = await requireRole("manager", { requestId, resource: "contact_reserved_context" });
  if (!auth.ok) return auth.response;
  const id = z
    .string()
    .uuid()
    .safeParse((await params).id);
  if (!id.success) return fail("not_found", "Contato não encontrado.", 404, { requestId });
  const db = await createClient();
  const { data, error } = await db.rpc("fn_reserved_contact_context", {
    p_org: auth.org.orgId,
    p_contact: id.data,
  });
  if (error)
    return fail("internal_error", "Não foi possível carregar o histórico reservado.", 500, {
      requestId,
    });
  return ok(data ?? [], { requestId });
}
