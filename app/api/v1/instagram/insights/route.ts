import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireRole } from "@/lib/auth/require-role";
import { ok, fail } from "@/lib/api/wrappers";
import { instagramInsights } from "@/lib/channels/social/instagram-insights";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  const requestId = randomUUID();
  const auth = await requireRole("viewer", { requestId });
  if (!auth.ok) return auth.response;
  const parsed = z
    .string()
    .regex(/^[a-f0-9]{24}$/)
    .optional()
    .safeParse(new URL(req.url).searchParams.get("account_id") ?? undefined);
  if (!parsed.success)
    return fail("invalid_request", "Selecione uma conta válida.", 400, { requestId });
  const limit = await checkRateLimit(`instagram-insights:${auth.org.orgId}`, 20, 60);
  if (!limit.allowed)
    return fail("rate_limited", "Aguarde um minuto para atualizar os resultados.", 429, {
      requestId,
    });
  try {
    return ok(await instagramInsights(auth.org.orgId, parsed.data), {
      requestId,
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return fail(
      "instagram_unavailable",
      "Não foi possível consultar os resultados. Confira a conexão e se a análise está habilitada no provedor da conta.",
      502,
      { requestId },
    );
  }
}
