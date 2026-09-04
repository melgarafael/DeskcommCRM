/**
 * O PAINEL DE PROVEDORES ALCANÇA TAMBÉM A PILHA ANTIGA.
 *
 * O sistema resolvia modelo por três caminhos que não se falam. O seam do
 * agente (`run-model-call.ts`) já obedece ao painel. Faltavam os pontos que
 * ainda passam por `lib/ai/gateway.ts` — `sentiment_classify`, `bot_respond` e
 * o ensaio de agente.
 *
 * Enquanto faltavam, a tela cometia o pior erro que uma tela de configuração
 * pode cometer: oferecia esses três pontos, aceitava a escolha, dizia "salvo" —
 * e nenhuma chamada a respeitava. Botão que não controla nada é pior que botão
 * ausente, porque gasta a confiança de quem clicou. É a mesma classe de defeito
 * que `tests/unit/pontos-de-ia-completude.test.ts` proíbe no registro; ela só
 * não era pega aqui porque o teste olha a LISTA, não a execução.
 *
 * ## Por que este módulo existe em vez de o worker chamar o seam
 *
 * O seam do agente fala `pg.Pool`; estes workers falam Supabase. Migrá-los para
 * o seam é a mudança certa e é grande — mexe em transação, em credencial e no
 * caminho que hoje responde o cliente. Este módulo é a ponte mínima que faz o
 * painel valer JÁ nos três pontos, sem reescrever o runtime que está no ar.
 * A unificação segue registrada como dívida no handoff.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

import { decryptKey, byteaToBuffer } from "@/lib/crypto/aes_gcm";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

import {
  NVIDIA_ENDPOINT,
  OLLAMA_DEFAULT_ENDPOINT,
  DEEPSEEK_ENDPOINT,
  QWEN_ENDPOINT,
  ZHIPU_ENDPOINT,
  MOONSHOT_ENDPOINT,
} from "@/lib/agent-engine/edge/llm/providers";

import { OPENROUTER_BASE_URL, resolveLanguageModel, type ModelId } from "./gateway";

export interface ModeloResolvido {
  model: LanguageModel;
  /** Para o log: qual modelo e de onde veio a decisão. */
  modelId: string;
  origem: "binding" | "padrao";
}

/**
 * Resolve o modelo de um ponto, honrando o painel quando há binding.
 *
 * `organizationId` é obrigatório porque binding é por organização — e um
 * resolvedor que aceitasse organização opcional acabaria chamado sem ela no
 * caminho que mais importa, aplicando a configuração de ninguém.
 *
 * Sem binding, devolve exatamente o que `resolveLanguageModel` devolvia: este
 * módulo não muda o comportamento de quem não configurou nada.
 */
export async function resolverModeloDoPonto(
  purpose: string,
  organizationId: string,
  padrao: ModelId,
): Promise<ModeloResolvido | null> {
  const binding = await lerBinding(purpose, organizationId);

  if (binding === null) {
    const model = resolveLanguageModel(padrao);
    return model === null ? null : { model, modelId: String(padrao), origem: "padrao" };
  }

  const apiKey = await decifrarChave(binding.credential_id, organizationId);
  if (apiKey === null) {
    // Binding configurado mas sem chave utilizável: cai no padrão em vez de
    // deixar o ponto morto. O aviso é o que impede isso de virar mais uma
    // falha muda — foi justamente o que esta frente veio acabar.
    logger.warn("[gateway-binding] binding sem credencial utilizável — usando o padrão", {
      organization_id: organizationId,
      purpose,
    });
    const model = resolveLanguageModel(padrao);
    return model === null ? null : { model, modelId: String(padrao), origem: "padrao" };
  }

  const model = instanciar(binding.provider, apiKey, binding.model_id, binding.base_url);
  if (model === null) {
    logger.warn("[gateway-binding] provider do binding é desconhecido — usando o padrão", {
      organization_id: organizationId,
      purpose,
      provider: binding.provider,
    });
    const fallback = resolveLanguageModel(padrao);
    return fallback === null ? null : { model: fallback, modelId: String(padrao), origem: "padrao" };
  }

  return { model, modelId: binding.model_id, origem: "binding" };
}

interface LinhaBinding {
  provider: string;
  credential_id: string | null;
  model_id: string;
  base_url: string | null;
}

async function lerBinding(
  purpose: string,
  organizationId: string,
): Promise<LinhaBinding | null> {
  try {
    const admin = createAdminClient();
    // Admin client bypassa RLS, então o filtro por organização é PROGRAMÁTICO e
    // obrigatório (CLAUDE.md, anti-pattern 10).
    const { data } = await admin
      .from("ai_purpose_bindings")
      .select("provider, credential_id, model_id, base_url")
      .eq("organization_id", organizationId)
      .eq("purpose", purpose)
      .eq("is_enabled", true)
      .maybeSingle();
    return (data as LinhaBinding | null) ?? null;
  } catch (err) {
    // Tabela ausente (clone sem o baseline aplicado) não pode derrubar o
    // atendimento — mas também não pode passar em silêncio.
    logger.warn("[gateway-binding] não consegui ler o binding — usando o padrão", {
      organization_id: organizationId,
      purpose,
      motivo: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Decifra a chave da organização. Plaintext só existe no retorno. */
async function decifrarChave(
  credentialId: string | null,
  organizationId: string,
): Promise<string | null> {
  if (credentialId === null) return null;
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("ai_provider_credentials")
      .select("api_key_encrypted, api_key_iv, api_key_tag")
      .eq("id", credentialId)
      .eq("organization_id", organizationId)
      .eq("is_active", true)
      .not("validated_at", "is", null)
      .maybeSingle();
    if (!data) return null;
    return decryptKey({
      ciphertext: byteaToBuffer(data.api_key_encrypted),
      iv: byteaToBuffer(data.api_key_iv),
      tag: byteaToBuffer(data.api_key_tag),
    });
  } catch {
    // Sem detalhe no log: qualquer eco aqui corre o risco de carregar material
    // da credencial.
    return null;
  }
}

/**
 * Instancia o provider. Espelha `createDefaultRegistry` do agent-engine — e a
 * duplicação é consciente e temporária: unificar exige que estes workers falem
 * `pg.Pool`, que é a dívida registrada no handoff. Provider desconhecido
 * devolve `null` para o chamador cair no padrão com aviso, nunca um fallback
 * silencioso para outro provedor.
 */
function instanciar(
  provider: string,
  apiKey: string,
  modelId: string,
  baseUrl: string | null,
): LanguageModel | null {
  switch (provider) {
    case "anthropic":
      return createAnthropic({ apiKey })(modelId);
    case "openai":
      return createOpenAI({ apiKey })(modelId);
    case "google":
      return createGoogleGenerativeAI({ apiKey })(modelId);
    case "openrouter":
      return createOpenAI({ apiKey, baseURL: baseUrl ?? OPENROUTER_BASE_URL })(modelId);
    case "nvidia":
      return createOpenAI({ apiKey, baseURL: baseUrl ?? NVIDIA_ENDPOINT })(modelId);
    case "ollama":
      return createOpenAI({ apiKey: apiKey || "ollama", baseURL: baseUrl ?? OLLAMA_DEFAULT_ENDPOINT })(
        modelId,
      );
    case "deepseek":
      return createOpenAI({ apiKey, baseURL: baseUrl ?? DEEPSEEK_ENDPOINT })(modelId);
    case "qwen":
      return createOpenAI({ apiKey, baseURL: baseUrl ?? QWEN_ENDPOINT })(modelId);
    case "zhipu":
      return createOpenAI({ apiKey, baseURL: baseUrl ?? ZHIPU_ENDPOINT })(modelId);
    case "moonshot":
      return createOpenAI({ apiKey, baseURL: baseUrl ?? MOONSHOT_ENDPOINT })(modelId);
    default:
      return null;
  }
}
