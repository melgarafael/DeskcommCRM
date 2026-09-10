import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/ai/credentials/codex — status do vínculo OAuth Codex da org
 *                                      ativa (manager+). Nunca expõe segredo.
 * POST /api/v1/ai/credentials/codex — inicia o device-code (admin). Devolve
 *                                      `{user_code, verification_uri, ...}`
 *                                      para o operador aprovar no browser.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { iniciarDeviceCode } from "@/lib/ai/codex/oauth";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const iniciarSchema = z.object({ label: z.string().trim().min(1).max(80).default("ChatGPT") });

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "ai_credentials" });
  if (!authz.ok) return authz.response;
  const { data } = await createAdminClient()
    .from("ai_provider_oauth")
    .select("provider, label, status, quarantined_reason, updated_at")
    .eq("organization_id", authz.org.orgId)
    .eq("provider", "openai-codex")
    .maybeSingle();
  return ok(data ?? { provider: "openai-codex", status: "ausente" }, { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "ai_credentials" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const parsed = iniciarSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return fail("validation_failed", t("Campos inválidos."), 422, { requestId });

  // R1 (ledger do SDD): sem OPENAI_CODEX_CLIENT_ID, fail instrutivo —
  // nunca throw cru na borda. Qualquer outro erro do provedor (rede, 5xx no
  // deviceauth) também vira fail com código — throw aqui seria 500 sem corpo
  // e o cartão mostraria genérico sem diagnóstico (bug do connect fantasma).
  let sessao;
  try {
    sessao = await iniciarDeviceCode();
  } catch (err) {
    const motivo = err instanceof Error ? err.message : String(err);
    if (motivo.includes("OPENAI_CODEX_CLIENT_ID")) {
      return fail("misconfigured", t("Assinatura ChatGPT não configurada nesta instalação."), 500, {
        requestId,
      });
    }
    logger.error("ai.codex.inicio falhou no provedor", { error: motivo, requestId });
    return fail("ai_provider_error", t("O provedor não respondeu. Tente de novo."), 502, {
      requestId,
    });
  }

  await audit({
    action: "ai.codex.inicio",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "ai_provider_oauth",
    requestId,
  });
  return ok(
    {
      user_code: sessao.userCode,
      verification_uri: sessao.verificationUri,
      expires_in: sessao.expiresIn,
      device_auth_id: sessao.deviceAuthId,
    },
    { requestId },
  );
}
