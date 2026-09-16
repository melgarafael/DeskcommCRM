/** GET /api/v1/advomax/pessoas — authorized search for link suggestions. */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { fail, ok } from "@/lib/api/wrappers";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "advomax_people_search" });
  if (!authz.ok) return authz.response;
  if (!process.env.ADVOMAX_API_URL?.trim() || !process.env.ADVOMAX_CRM_INTEGRATION_KEY?.trim()) {
    return fail("integration_unavailable", "A integração com o Advomax não está configurada.", 503, { requestId });
  }
  const params = new URLSearchParams();
  const nome = req.nextUrl.searchParams.get("nome")?.trim();
  if (nome) params.set("nome", nome.slice(0, 80));
  if (req.nextUrl.searchParams.get("somenteClientes") === "true") params.set("somenteClientes", "true");
  const offset = Number.parseInt(req.nextUrl.searchParams.get("offset") ?? "0", 10);
  const limite = Number.parseInt(req.nextUrl.searchParams.get("limite") ?? "200", 10);
  params.set("offset", String(Number.isSafeInteger(offset) && offset >= 0 ? offset : 0));
  params.set("limite", String(Number.isSafeInteger(limite) ? Math.min(200, Math.max(1, limite)) : 200));
  const base = process.env.ADVOMAX_API_URL.replace(/\/$/, "");
  const response = await fetch(`${base}/integracoes/crm/pessoas?${params.toString()}`, {
    headers: {
      "X-CRM-Integration-Key": process.env.ADVOMAX_CRM_INTEGRATION_KEY,
      "X-CRM-User-Email": authz.user.email,
      "X-CRM-Organization-Id": authz.org.orgId,
    },
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!response?.ok) return fail("bad_gateway", "Não foi possível consultar as Pessoas no Advomax.", 502, { requestId });
  const body = await response.json().catch(() => null);
  if (!Array.isArray(body)) return fail("bad_gateway", "O Advomax devolveu uma lista inválida.", 502, { requestId });
  return ok(body, { requestId });
}
