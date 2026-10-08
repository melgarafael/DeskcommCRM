import { createAdminClient } from "@/lib/supabase/admin";
import { lerLoginCodexRenovandoSeProxima } from "@/lib/ai/credenciais/login-codex";
import { PROVEDOR_POR_ASSINATURA } from "@/lib/ai/pontos/provedores";

export interface ModeloDaAssinatura {
  provider: typeof PROVEDOR_POR_ASSINATURA;
  model_id: string;
  display_name: string;
  description: null;
  context_window: null;
  input_price_per_million_cents: null;
  output_price_per_million_cents: null;
  supports_tools: boolean;
  supports_vision: boolean;
  is_default_for_provider: false;
  deprecated_at: null;
}

/** Busca os modelos que a conta ChatGPT autorizou a listar, sempre no tenant atual. */
export async function listarModelosDaAssinatura(orgId: string): Promise<ModeloDaAssinatura[] | null> {
  const admin = createAdminClient();
  const tokens = await lerLoginCodexRenovandoSeProxima({ admin, orgId });
  if (!tokens) return null;

  let response: Response;
  try {
    response = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
      cache: "no-store",
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;

  const body: unknown = await response.json().catch(() => null);
  // Um 200 em formato que não conhecemos não é "a conta não tem modelos":
  // gravar `[]` a partir dele apagaria a lista válida e travaria todo
  // "Publicar" da empresa. Responde vazio e não toca no espelho.
  if (!body || typeof body !== "object" || !("models" in body) || !Array.isArray(body.models)) {
    return [];
  }
  const rows: unknown[] = body.models;
  const models = rows.flatMap((row: unknown): ModeloDaAssinatura[] => {
    if (!row || typeof row !== "object") return [];
    const model = row as { slug?: unknown; id?: unknown; display_name?: unknown; visibility?: unknown };
    const modelId = typeof model.slug === "string" ? model.slug : typeof model.id === "string" ? model.id : null;
    if (!modelId || model.visibility !== "list") return [];
    return [{
      provider: PROVEDOR_POR_ASSINATURA,
      model_id: modelId,
      display_name: typeof model.display_name === "string" ? model.display_name : modelId,
      description: null,
      context_window: null,
      input_price_per_million_cents: null,
      output_price_per_million_cents: null,
      // O endpoint autenticado só lista modelos liberados para uso de chat; a
      // assinatura os executa pelo mesmo runtime OpenAI com tool calling.
      supports_tools: true,
      supports_vision: true,
      is_default_for_provider: false,
      deprecated_at: null,
    }];
  });

  // Espelho por organização para a validação SQL de publicação dos agentes.
  const { data: credential } = await admin
    .from("ai_provider_credentials")
    .select("id")
    .eq("organization_id", orgId)
    .eq("provider", PROVEDOR_POR_ASSINATURA)
    .eq("is_active", true)
    .maybeSingle();
  if (credential?.id) {
    await admin
      .from("ai_provider_credentials")
      .update({ models_available: models.map((model) => model.model_id) })
      .eq("id", credential.id)
      .eq("organization_id", orgId);
  }
  return models;
}
