/**
 * GET /api/v1/ai/followup-flows/modelos-aprovados — os modelos aprovados do canal
 * que um passo de fluxo consegue enviar sozinho (viewer+, como a leitura do fluxo).
 *
 * É a lista do seletor de modelo no construtor. A de `/api/v1/channels/templates`
 * não serve: pede `admin` (quem edita fluxo é `manager`), não devolve o `id` que o
 * passo grava e inclui o que o fluxo não consegue mandar. A regra do que entra
 * mora em `lib/followup/modelos-aprovados.ts`.
 */
import { randomUUID } from "node:crypto";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { modelosQueOFluxoEnvia, type LinhaDeModeloDoCanal } from "@/lib/followup/modelos-aprovados";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "followup_flows" });
  if (!authz.ok) return authz.response;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("meta_templates")
    .select("id, name, language, status, parameter_format, components")
    .eq("organization_id", authz.org.orgId)
    .order("name");
  if (error) return fail("internal_error", error.message, 500, { requestId });

  return ok(modelosQueOFluxoEnvia((data ?? []) as LinhaDeModeloDoCanal[]), { requestId });
}
