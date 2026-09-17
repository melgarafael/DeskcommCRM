import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/conversations/open-with-contact
 *
 * Resolve o contato do cartão compartilhado e abre a conversa 1:1 na mesma sessão
 * de canal — comportamento equivalente ao toque no contato no WhatsApp.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { resolveAuthDual } from "@/lib/api/auth-dual";
import { ApiError } from "@/lib/api/types";
import { ok, fail } from "@/lib/api/wrappers";
import { openSharedContactConversation } from "@/lib/messaging/open-shared-contact-conversation";
import { openConversationWithContactSchema, validateRequest } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase/admin";
import { traduzir } from "@/lib/i18n/dicionario";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();

  // Sessão de navegador OU token de servidor: é o passo que antecede o envio,
  // e quem envia por token precisa poder resolver a conversa pelo telefone.
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "conversations",
    role: "agent",
    scope: "mcp:write",
  });
  if (!authz.ok) return authz.response;
  // O ramo do token não carrega idioma de usuário: cai no padrão do produto.
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);

  let input;
  try {
    input = await validateRequest(openConversationWithContactSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  try {
    const admin = createAdminClient();
    const result = await openSharedContactConversation(admin, authz.organizationId, input);
    return ok(result, { requestId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "open_failed";
    if (msg === "contact_not_found") {
      return fail("not_found", t("Contato não encontrado."), 404, { requestId });
    }
    if (msg === "session_not_found") {
      return fail("not_found", t("Sessão de canal não encontrada."), 404, { requestId });
    }
    if (msg === "invalid_phone") {
      return fail("validation_error", t("Telefone inválido."), 422, { requestId });
    }
    return fail("internal_error", msg, 500, { requestId });
  }
}
