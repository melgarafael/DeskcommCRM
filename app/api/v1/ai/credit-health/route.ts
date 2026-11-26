import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { avisosDeSaldoDaIa } from "@/lib/ai/saude-do-saldo";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

export async function GET() {
  const authz = await requireRole("agent", { resource: "ai_credit_health" });
  if (!authz.ok) return authz.response;

  try {
    const avisos = await avisosDeSaldoDaIa(getRequestPool(), authz.org.orgId);
    return ok({ orgId: authz.org.orgId, avisos }, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return fail(
      "internal_error",
      traduzir("Não foi possível consultar o saldo da IA.", authz.user.idioma),
      503,
    );
  }
}
