import { requireRole } from "@/lib/auth/require-role";
import { fail } from "@/lib/api/wrappers";
import { carregarModulos } from "./server";

/** Gate por requisição, compartilhado pelas APIs da academia; nunca confia no menu. */
export async function requireAcademia(requestId: string) {
  const auth = await requireRole("viewer", { requestId, resource: "academia" });
  if (!auth.ok) return auth;
  try {
    if (!(await carregarModulos(auth.org.orgId)).academia) {
      return { ok: false as const, response: fail("module_disabled", "O módulo Academia está desativado nesta empresa.", 403, { requestId }) };
    }
    return auth;
  } catch {
    return { ok: false as const, response: fail("internal_error", "Não foi possível conferir o módulo.", 500, { requestId }) };
  }
}
