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
import { guardarCredencial } from "@/lib/ai/credenciais/guardar";
import { IDS_COM_CHAVE } from "@/lib/ai/pontos/provedores";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const SAFE_COLUMNS =
  "id, organization_id, provider, label, api_key_last4, base_url, validated_at, validation_error, models_available, is_active, created_by, created_at, updated_at";

const createSchema = z.object({
  // Derivado de `lib/ai/pontos/provedores.ts`, a lista única desde a migration
  // 0127. Enquanto era uma cópia à mão, o banco aceitava OpenRouter e ESTA rota
  // recusava com 422 — o operador via a tela de Provedores oferecer OpenRouter
  // e não tinha onde cadastrar a chave. A UNIÃO, e não só quem conversa: a
  // chave do Jev (que só decide) se cadastra por aqui também.
  provider: z.enum(IDS_COM_CHAVE),
  label: z.string().trim().min(1).max(80),
  api_key: z.string().trim().min(8).max(2048),
  /**
   * Só o provedor personalizado (#1642): o endereço da API compatível com a
   * OpenAI que vai RECEBER a chave. A obrigatoriedade (e a recusa para os
   * nativos) é checada depois do parse, porque aí a resposta é a frase que
   * diz o que falta — `z.string().min(1)` devolveria "Campos inválidos.",
   * que manda a pessoa adivinhar qual campo.
   */
  base_url: z.string().trim().max(500).optional(),
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
  const provider = input.provider;

  // Barra final removida antes de gravar, como `lib/webhooks/url-publica.ts`
  // decidiu para o mesmo formato: `base + "/" + caminho` viraria `.../v1//models`.
  const baseUrl = (input.base_url ?? "").trim().replace(/\/+$/, "");
  if (provider === "custom" && baseUrl === "") {
    return fail(
      "validation_failed",
      t("Informe o endereço (base URL) do provedor personalizado."),
      422,
      { requestId },
    );
  }
  if (baseUrl !== "" && !/^https?:\/\//i.test(baseUrl)) {
    return fail(
      "validation_failed",
      t("O endereço (base URL) precisa começar com http:// ou https://."),
      422,
      { requestId },
    );
  }
  // Os quatro nativos continuam 100% iguais: o endpoint deles é intrínseco, e
  // gravar endereço ao lado de uma chave da OpenAI seria configuração que o
  // runtime lê e ninguém preencheu pela tela. Quem quer endpoint próprio num
  // nativo aponta o BINDING no painel de provedores — caminho que já existe.
  if (provider !== "custom" && baseUrl !== "") {
    return fail(
      "validation_failed",
      t("Só o provedor personalizado aceita um endereço (base URL) próprio."),
      422,
      { requestId },
    );
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
    baseUrl: baseUrl === "" ? undefined : baseUrl,
    requestId,
  });

  if (!guardado.ok) {
    if (guardado.motivo === "label_em_uso") {
      return fail(
        "label_already_used",
        t("Já existe uma chave deste provedor com este nome. Dê outro nome a ela."),
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
