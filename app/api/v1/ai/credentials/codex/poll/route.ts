import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/ai/credentials/codex/poll — confere se o operador já aprovou
 * no browser (admin). `{pendente:true}` enquanto ele não aprova; na aprovação
 * salva o refresh CIFRADO e devolve `{conectado:true}` — os tokens NUNCA
 * atravessam a resposta.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { trocarDeviceCodePorTokens, extrairIdDaConta } from "@/lib/ai/codex/oauth";
import { salvarVinculo } from "@/lib/ai/codex/armazenamento";
import { createAdminClient } from "@/lib/supabase/admin";
import { logger } from "@/lib/logger";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const pollSchema = z.object({
  device_auth_id: z.string().trim().min(8).max(512),
  user_code: z.string().trim().min(4).max(32),
  label: z.string().trim().min(1).max(80).default("ChatGPT"),
});

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "ai_credentials" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const parsed = pollSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", t("Campos inválidos."), 422, { requestId });

  let troca;
  try {
    troca = await trocarDeviceCodePorTokens(parsed.data.device_auth_id, parsed.data.user_code);
  } catch (err) {
    const motivo = err instanceof Error ? err.message : String(err);
    if (motivo.includes("OPENAI_CODEX_CLIENT_ID")) {
      return fail("misconfigured", t("Assinatura ChatGPT não configurada nesta instalação."), 500, {
        requestId,
      });
    }
    logger.error("ai.codex.poll falhou no provedor", { error: motivo, requestId });
    return fail("ai_provider_error", t("A verificação falhou. Tente de novo."), 502, {
      requestId,
    });
  }
  if (troca.pendente) return ok({ pendente: true }, { requestId });

  const admin = createAdminClient();
  let id: string;
  try {
    ({ id } = await salvarVinculo({
      admin,
      orgId: authz.org.orgId,
      userId: authz.user.id,
      label: parsed.data.label,
      refreshToken: troca.refreshToken,
      // Identidade da conta para o futuro spike de execução (header
      // `ChatGPT-Account-ID`). Null quando o provedor não a devolveu — o
      // vínculo continua válido para refresh; o spike preenche depois.
      accountId: extrairIdDaConta(troca.idToken),
    }));
  } catch (err) {
    const motivo = err instanceof Error ? err.message : String(err);
    logger.error("ai.codex.poll falhou ao gravar o vínculo", { error: motivo, requestId });
    return fail("internal_error", t("Conectei no provedor mas não consegui guardar. Tente de novo."), 500, {
      requestId,
    });
  }
  await audit({
    action: "ai.codex.conexao",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "ai_provider_oauth",
    resourceId: id,
    requestId,
  });
  return ok({ conectado: true }, { requestId });
}
