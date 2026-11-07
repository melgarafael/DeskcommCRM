/**
 * Épico Operação Visível (F1) — GET: conteúdo de uma versão específica da
 * memória da org, para o Dialog de histórico da UI (Task 6).
 *
 * Aceita sessão de navegador OU Bearer `dsk_…` com escopo `config:read`
 * e papel admin (`tokenRole`). A organização vem da linha do token, nunca do corpo.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";
import { createAdminClient } from "@/lib/supabase/admin";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) {
    return fail("invalid_request", "id inválido.", 400, { requestId });
  }

  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "org_memory_version_get",
    role: "agent",
    scope: "config:read",
    tokenRole: "admin",
  });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);
  const teto = await tetoDeEscritaDoToken(authz, "org_memory_versions", requestId);
  if (teto) return teto;

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("org_memory_versions")
    .select("id, version_number, content, created_at")
    .eq("id", id)
    .eq("organization_id", authz.organizationId)
    .maybeSingle();
  if (error) {
    return fail("internal_error", t("Erro ao carregar a versão da memória."), 500, { requestId });
  }
  if (!data) {
    return fail("not_found", t("Versão não encontrada nesta organização."), 404, { requestId });
  }

  return ok(data, { requestId });
}
