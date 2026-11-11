import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { extensionFailure, extensionId } from "@/lib/extensions/http";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { emitirJwtDeContexto } from "@/lib/modulo/jwt-de-contexto";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const SEM_CACHE = { "Cache-Control": "no-store" };

/**
 * Entrega à TELA de um módulo `connected` o JWT de contexto (spec 33, F3, tarefa 4): `{ jwt,
 * expires_at }`, com `sub` = quem está logado, `org` = a organização ativa da sessão e `inst` = esta
 * instalação, validade de 5 minutos, assinado com ES256 (`MODULE_JWT_PRIVATE_KEY`).
 *
 * Rota de SESSÃO (`requireRole`, que já cobra MFA); fora de `lib/auth/public-paths.ts`: nenhum token
 * a alcança. A organização vem da sessão, nunca do corpo. O JWT só identifica a pessoa; o papel dela
 * é lido do banco a cada chamada do módulo. Sem a chave configurada, 503 com mensagem clara.
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  try {
    const denied = await requireSupportWrite();
    if (denied) return denied;
    const authz = await requireRole("viewer", { requestId, resource: "organization_extensions" });
    if (!authz.ok) return authz.response;
    const installationId = extensionId((await context.params).id);
    const organizationId = authz.org.orgId;

    // A instalação tem de estar LIGADA nesta organização e viva (filtros explícitos: admin client).
    const supabase = createAdminClient();
    const [vinculo, instalacao] = await Promise.all([
      supabase
        .from("organization_extensions")
        .select("enabled")
        .eq("organization_id", organizationId)
        .eq("installation_id", installationId)
        .maybeSingle(),
      supabase
        .from("extension_installations")
        .select("disabled_at, removed_at")
        .eq("id", installationId)
        .maybeSingle(),
    ]);
    if (vinculo.error || instalacao.error) {
      return fail("internal_error", "Não foi possível concluir o pedido agora. Tente de novo.", 503, {
        requestId,
        headers: SEM_CACHE,
      });
    }
    if (
      !vinculo.data ||
      vinculo.data.enabled !== true ||
      !instalacao.data ||
      instalacao.data.disabled_at ||
      instalacao.data.removed_at
    ) {
      return fail("not_found", "Módulo não encontrado ou desligado nesta organização.", 404, {
        requestId,
        headers: SEM_CACHE,
      });
    }

    const emitido = await emitirJwtDeContexto({
      pessoaId: authz.user.id,
      organizationId,
      installationId,
    });
    if (!emitido) {
      return fail(
        "module_context_unavailable",
        "O contexto de pessoa dos módulos não está configurado nesta instalação (falta MODULE_JWT_PRIVATE_KEY). O módulo continua funcionando, sem agir em nome de uma pessoa.",
        503,
        { requestId, headers: SEM_CACHE },
      );
    }
    return ok(emitido, { requestId, headers: SEM_CACHE });
  } catch (error) {
    return extensionFailure(error);
  }
}
