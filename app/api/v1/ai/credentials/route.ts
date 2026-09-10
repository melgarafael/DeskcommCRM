import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/ai/credentials — lista credentials da org ativa (manager+).
 *                                Lê da view `ai_provider_credentials_safe`,
 *                                que NUNCA expõe campos cifrados.
 * POST /api/v1/ai/credentials — cria credential (admin). Plaintext da api_key
 *                                entra apenas neste endpoint, é cifrado AES-GCM
 *                                e descartado da memória. Validação async não
 *                                bloqueia a resposta.
 *
 * Spec 10 §4.2 / §7.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { type Provider } from "@/lib/ai/provider-validators";
import { guardarCredencial } from "@/lib/ai/credenciais/guardar";
import { IDS_DE_PROVEDOR } from "@/lib/ai/pontos/provedores";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const SAFE_COLUMNS =
  "id, organization_id, provider, label, api_key_last4, validated_at, validation_error, models_available, is_active, created_by, created_at, updated_at";

const createSchema = z.object({
  // Derivado de `lib/ai/pontos/provedores.ts`, a lista única desde a migration
  // 0127. Enquanto era uma cópia à mão, o banco aceitava OpenRouter e ESTA rota
  // recusava com 422 — o operador via a tela de Provedores oferecer OpenRouter
  // e não tinha onde cadastrar a chave.
  provider: z.enum(IDS_DE_PROVEDOR),
  label: z.string().trim().min(1).max(80),
  api_key: z.string().trim().min(8).max(2048),
});

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "ai_credentials" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("ai_provider_credentials_safe")
    .select(SAFE_COLUMNS)
    .eq("organization_id", activeOrg.orgId)
    .order("created_at", { ascending: false });

  if (error) {
    return fail("internal_error", "Erro ao listar credentials.", 500, { requestId });
  }
  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "ai_credentials" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user: authUser, org: activeOrg } = authz;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return fail("invalid_request", t("Body JSON inválido."), 400, { requestId });
  }

  const parsed = createSchema.safeParse(rawBody);
  if (!parsed.success) {
    return fail("validation_failed", t("Campos inválidos."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const input = parsed.data;
  const provider = input.provider as Provider;

  // Assinatura não se cola: o vínculo OAuth nasce em
  // POST /api/v1/ai/credentials/codex (tabela própria, refresh cifrado).
  // Aceitar aqui gravaria em ai_provider_credentials uma linha que o resolver
  // nunca leria — credencial fantasma com tela dizendo "salva".
  if (provider === "openai-codex") {
    return fail("validation_failed", t("Assinatura ChatGPT se conecta via OAuth, não colando chave."), 422, {
      requestId,
    });
  }

  // O miolo — cifrar, gravar, auditar e validar em segundo plano — mora em
  // `lib/ai/credenciais/guardar.ts` porque o wizard precisa exatamente do mesmo
  // e cada item dessa lista tem consequência de segurança se as duas cópias
  // divergirem. Aqui ficam auth, formato do erro e o `requestId`.
  const guardado = await guardarCredencial({
    admin: createAdminClient(),
    orgId: activeOrg.orgId,
    userId: authUser.id,
    provider,
    label: input.label,
    apiKey: input.api_key,
    requestId,
  });

  if (!guardado.ok) {
    if (guardado.motivo === "label_em_uso") {
      return fail(
        "label_already_used",
        t("Já existe uma credential com este label e provider."),
        409,
        { requestId },
      );
    }
    return fail("internal_error", "Erro ao criar credential.", 500, { requestId });
  }

  // A resposta continua saindo da view segura: ela é quem garante que nenhum
  // campo cifrado atravesse a fronteira HTTP.
  const { data: created } = await createAdminClient()
    .from("ai_provider_credentials_safe")
    .select(SAFE_COLUMNS)
    .eq("id", guardado.id)
    .single();

  return ok(created, { status: 201, requestId });
}
