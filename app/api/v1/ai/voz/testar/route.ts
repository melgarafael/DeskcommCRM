import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * "Testar" a chave de voz gravada: lista as vozes pt-BR no Google Cloud
 * Text-to-Speech (não sintetiza nada) e grava o veredito na credencial.
 *
 * Responde só `{ ok: true, vozes: N }` ou `{ ok: false, erro: <código> }` —
 * `auth_failed_403` costuma ser a API não habilitada no projeto ou a chave
 * restrita a outra API. Nunca a chave, a URL ou a resposta do Google.
 */
import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { testarChaveDeVoz } from "@/lib/ai/voz/credencial";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function POST(): Promise<Response> {
  // Grava o veredito na credencial: é escrita, e suporte temporário não a faz.
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "ai_credentials" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  let r: Awaited<ReturnType<typeof testarChaveDeVoz>>;
  try {
    r = await testarChaveDeVoz(createAdminClient(), {
      organizationId: authz.org.orgId,
      userId: authz.user.id,
      requestId,
    });
  } catch {
    return fail("internal_error", t("Não consegui testar a chave."), 500, { requestId });
  }
  if (r === null) {
    return fail("validation_failed", t("Grave uma chave antes de testar."), 422, { requestId });
  }
  return ok(r, { requestId });
}
