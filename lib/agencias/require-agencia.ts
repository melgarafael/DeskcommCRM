import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { fail } from "@/lib/api/wrappers";

/** O papel da plataforma não substitui o vínculo direto da agência. */
export async function requireAgencia(requestId: string) {
  const auth = await requireRole("admin", { requestId, allowPlatformAdmin: false });
  if (!auth.ok) return auth;
  if (auth.user.support)
    return {
      ok: false as const,
      response: fail("forbidden", "Encerre o acompanhamento antes de administrar clientes.", 403, {
        requestId,
      }),
    };
  const db = await createClient();
  const { data, error } = await db.rpc("fn_agencia_pode_gerir", { p_agencia: auth.org.orgId });
  if (error)
    return {
      ok: false as const,
      response: fail(
        "upstream_unavailable",
        "Não foi possível confirmar a autorização da agência.",
        503,
        { requestId },
      ),
    };
  if (data !== true)
    return {
      ok: false as const,
      response: fail(
        "forbidden",
        "Esta organização não está autorizada a administrar clientes.",
        403,
        { requestId },
      ),
    };
  return { ...auth, db };
}
