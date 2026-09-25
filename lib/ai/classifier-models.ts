/**
 * Modelos que ESTA organização consegue de fato usar como classificador.
 *
 * ─── Por que a lista é filtrada por credencial, e não é o catálogo inteiro ────
 * O catálogo (`ai_models`) descreve o que existe no mundo; ele não sabe se a
 * organização tem chave paga do provedor. Oferecer tudo produz o pior desfecho
 * possível: o operador escolhe um modelo, salva, e o classificador falha em
 * silêncio a cada mensagem — a tela mostra "nenhuma intenção casou", que é uma
 * frase sobre o TEXTO dele, não sobre a chave que falta. Foi assim que uma
 * organização passou a tarde trocando frases de exemplo contra um problema de
 * billing.
 *
 * ─── As duas origens de credencial, e por que ambas contam ───────────────────
 *  - BYOK: `ai_provider_credentials` ativa E validada (é o que
 *    `resolveOrgLlmConfig` exige para usar a chave da organização).
 *  - Plataforma: `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` do ambiente, o fallback
 *    de quem hospeda o próprio sistema e configurou a chave no `.env`.
 *
 * Ter a chave não garante que ela tenha saldo — isso só o provedor sabe, na
 * hora da chamada. O que esta lista garante é que não oferecemos um caminho que
 * NUNCA teria como funcionar.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ehProvedorSuportado } from "@/lib/ai/pontos/provedores";

/** Um modelo oferecível, já com o provedor que precisa viajar junto dele. */
export interface ClassifierModelOption {
  provider: string;
  model_id: string;
  display_name: string;
  /** O provedor tem credencial por BYOK (`org`) ou pela chave da instalação (`plataforma`). */
  origem: "org" | "plataforma";
}

/** Chaves de plataforma disponíveis, por provedor. */
export interface PlatformKeys {
  anthropic: boolean;
  openai: boolean;
}

export async function listClassifierModels(
  db: SupabaseClient,
  organizationId: string,
  platformKeys: PlatformKeys,
): Promise<ClassifierModelOption[]> {
  const { data: creds, error: credErr } = await db
    .from("ai_provider_credentials")
    .select("provider")
    .eq("organization_id", organizationId)
    .eq("is_active", true)
    .not("validated_at", "is", null);
  // Erro aqui NÃO vira lista vazia: sem credencial nenhuma a tela some com o
  // seletor, e o operador conclui que o produto não deixa escolher o modelo —
  // quando na verdade a consulta falhou. Sobe para quem sabe tratar.
  if (credErr) throw new Error(`classifier_models_credentials_failed: ${credErr.message}`);

  const origemPorProvider = new Map<string, "org" | "plataforma">();
  for (const c of (creds ?? []) as Array<{ provider: string }>) {
    // Só quem CONVERSA classifica. A chave do Jev (que só decide) entraria na
    // consulta ao catálogo, e uma linha dele em `ai_models` viraria opção de
    // classificador — um modelo que o runtime do agente nem sabe instanciar.
    if (ehProvedorSuportado(c.provider)) origemPorProvider.set(c.provider, "org");
  }
  if (platformKeys.anthropic && !origemPorProvider.has("anthropic")) {
    origemPorProvider.set("anthropic", "plataforma");
  }
  if (platformKeys.openai && !origemPorProvider.has("openai")) {
    origemPorProvider.set("openai", "plataforma");
  }
  if (origemPorProvider.size === 0) return [];

  const { data: models, error: modelErr } = await db
    .from("ai_models")
    .select("provider, model_id, display_name, is_default_for_provider, deprecated_at")
    .in("provider", [...origemPorProvider.keys()])
    .is("deprecated_at", null)
    .order("provider", { ascending: true })
    .order("is_default_for_provider", { ascending: false })
    .order("display_name", { ascending: true });
  if (modelErr) throw new Error(`classifier_models_catalog_failed: ${modelErr.message}`);

  return ((models ?? []) as Array<{ provider: string; model_id: string; display_name: string | null }>).map(
    (m) => ({
      provider: m.provider,
      model_id: m.model_id,
      display_name: m.display_name ?? m.model_id,
      origem: origemPorProvider.get(m.provider) ?? "plataforma",
    }),
  );
}
