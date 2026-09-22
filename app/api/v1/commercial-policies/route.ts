/**
 * GET /api/v1/commercial-policies — as travas da org (leitura).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "commercial_policies" });
  if (!authz.ok) return authz.response;

  const supabase = await createClient();
  const { data } = await supabase
    .from("commercial_policies")
    .select("desconto_max_vendedor_pct, permite_estoque_negativo, comissao_padrao_pct")
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();

  return ok(
    data ?? { desconto_max_vendedor_pct: 5, permite_estoque_negativo: false, comissao_padrao_pct: null },
    { requestId },
  );
}
