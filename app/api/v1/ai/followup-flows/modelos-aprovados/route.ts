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
import type { NextRequest } from "next/server";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { ok, fail } from "@/lib/api/wrappers";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";
import { modelosQueOFluxoEnvia, type LinhaDeModeloDoCanal } from "@/lib/followup/modelos-aprovados";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "followup_flows",
    role: "viewer",
    scope: "config:read",
    tokenRole: "admin",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "followup_flows", requestId);
  if (teto) return teto;
  const { organizationId } = authz;

  const supabase = authz.supabase;
  const { data, error } = await supabase
    .from("meta_templates")
    .select("id, name, language, status, parameter_format, components")
    .eq("organization_id", organizationId)
    .order("name");
  if (error) return fail("internal_error", error.message, 500, { requestId });

  return ok(modelosQueOFluxoEnvia((data ?? []) as LinhaDeModeloDoCanal[]), { requestId });
}
