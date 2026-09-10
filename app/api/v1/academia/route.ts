import { randomUUID } from "node:crypto";
import { requireAcademia } from "@/lib/modules/require-academia";
import { ok } from "@/lib/api/wrappers";
export const dynamic = "force-dynamic";
export async function GET() {
  const requestId = randomUUID();
  const auth = await requireAcademia(requestId);
  if (!auth.ok) return auth.response;
  return ok({ organization_name: auth.org.name, enabled: true }, { requestId, headers: { "Cache-Control": "no-store" } });
}
