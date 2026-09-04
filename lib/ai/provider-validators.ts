/**
 * Pings síncronos para validar API keys BYO de provedores LLM.
 *
 * Uso:
 *   const result = await validateProviderKey("anthropic", apiKey);
 *   if (result.ok) → grava `validated_at = now()`, `models_available = result.models`
 *   else → grava `validation_error = result.error`
 *
 * Timeout 5s, sem retry. Erros 401 são distintos de erros de rede.
 */
import { PROVEDORES } from "@/lib/ai/pontos/provedores";

/**
 * Os provedores cuja CHAVE este arquivo sabe validar.
 *
 * Derivado de `lib/ai/pontos/provedores.ts`, que é a lista única desde a
 * migration 0127 — quando ela era repetida à mão aqui, na rota de credenciais,
 * no diálogo da tela e em `lib/ai/agents/validation.ts`, a 0127 abriu o banco
 * para a OpenRouter e as quatro cópias continuaram recusando. O resultado era
 * uma tela que oferecia OpenRouter num ponto e não tinha onde cadastrar a
 * chave dela.
 */
export type Provider = (typeof PROVEDORES)[number]["id"];

export interface ValidationOk {
  ok: true;
  models: string[];
}

export interface ValidationFail {
  ok: false;
  error: string;
}

export type ValidationResult = ValidationOk | ValidationFail;

const TIMEOUT_MS = 5000;

async function timedFetch(url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

export async function validateAnthropicKey(apiKey: string): Promise<ValidationResult> {
  try {
    const res = await timedFetch("https://api.anthropic.com/v1/models", {
      method: "GET",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: "auth_failed_401" };
    }
    if (!res.ok) {
      return { ok: false, error: `provider_status_${res.status}` };
    }
    const json = (await res.json()) as { data?: { id: string }[] };
    const models = (json.data ?? []).map((m) => m.id).filter(Boolean);
    return { ok: true, models };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.name : "network_error" };
  }
}

export async function validateOpenAIKey(apiKey: string): Promise<ValidationResult> {
  try {
    const res = await timedFetch("https://api.openai.com/v1/models", {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: "auth_failed_401" };
    }
    if (!res.ok) {
      return { ok: false, error: `provider_status_${res.status}` };
    }
    const json = (await res.json()) as { data?: { id: string }[] };
    const models = (json.data ?? []).map((m) => m.id).filter(Boolean);
    return { ok: true, models };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.name : "network_error" };
  }
}

export async function validateGoogleKey(apiKey: string): Promise<ValidationResult> {
  // Google Generative Language API — listModels com api key em query string é o
  // único endpoint público de discovery. A key permanece server-side, nunca
  // chega ao browser, e este request não é logado pelo nosso edge.
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(
      apiKey,
    )}`;
    const res = await timedFetch(url, { method: "GET" });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: "auth_failed_401" };
    }
    if (!res.ok) {
      return { ok: false, error: `provider_status_${res.status}` };
    }
    const json = (await res.json()) as { models?: { name?: string }[] };
    const models = (json.models ?? [])
      .map((m) => (m.name ?? "").replace(/^models\//, ""))
      .filter(Boolean);
    return { ok: true, models };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.name : "network_error" };
  }
}

/**
 * OpenRouter expõe `/api/v1/key` (metadados da própria chave) e `/api/v1/models`
 * (catálogo). Validamos pelo catálogo porque ele responde a mesma pergunta —
 * "esta chave é aceita?" — e já devolve a lista de modelos que a interface usa,
 * do mesmo jeito que os três irmãos acima.
 */
export async function validateOpenRouterKey(apiKey: string): Promise<ValidationResult> {
  try {
    const res = await timedFetch("https://openrouter.ai/api/v1/models", {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: "auth_failed_401" };
    }
    if (!res.ok) {
      return { ok: false, error: `provider_status_${res.status}` };
    }
    const json = (await res.json()) as { data?: { id?: string }[] };
    const models = (json.data ?? []).map((m) => m.id ?? "").filter(Boolean);
    return { ok: true, models };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.name : "network_error" };
  }
}

/**
 * Os quatro provedores abaixo (NVIDIA, DeepSeek, Qwen, Zhipu, Moonshot) falam
 * a mesma forma de discovery da OpenRouter: `GET /models` com
 * `Authorization: Bearer`, devolvendo `{ data: [{ id }] }`. Uma fábrica
 * genérica evita repetir o mesmo corpo cinco vezes — a única variação real é
 * a URL.
 */
function validadorEstiloOpenAI(baseUrl: string) {
  return async function validar(apiKey: string): Promise<ValidationResult> {
    try {
      const res = await timedFetch(`${baseUrl}/models`, {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (res.status === 401 || res.status === 403) {
        return { ok: false, error: "auth_failed_401" };
      }
      if (!res.ok) {
        return { ok: false, error: `provider_status_${res.status}` };
      }
      const json = (await res.json()) as { data?: { id?: string }[] };
      const models = (json.data ?? []).map((m) => m.id ?? "").filter(Boolean);
      return { ok: true, models };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.name : "network_error" };
    }
  };
}

export const validateNvidiaKey = validadorEstiloOpenAI("https://integrate.api.nvidia.com/v1");
export const validateDeepSeekKey = validadorEstiloOpenAI("https://api.deepseek.com/v1");
export const validateQwenKey = validadorEstiloOpenAI("https://dashscope.aliyuncs.com/compatible-mode/v1");
export const validateZhipuKey = validadorEstiloOpenAI("https://open.bigmodel.cn/api/paas/v4");
export const validateMoonshotKey = validadorEstiloOpenAI("https://api.moonshot.cn/v1");

/**
 * Ollama não tem "chave" — o que existe pra validar é se o endpoint local
 * responde. `apiKey` aqui é, na prática, o `baseUrl` que o operador digitou
 * na tela (o painel de Credenciais não tem campo de endpoint separado do de
 * chave para provedores BYOK; ver decisão em `app`), com fallback pro
 * default local quando vier vazio. Sem 401/403: Ollama não autentica por
 * padrão, então "responde e lista modelos" já é a prova de que dá certo.
 */
export async function validateOllamaEndpoint(baseUrlOuVazio: string): Promise<ValidationResult> {
  const baseUrl = (baseUrlOuVazio || "http://localhost:11434/v1").replace(/\/+$/, "");
  try {
    const res = await timedFetch(`${baseUrl}/models`, { method: "GET" });
    if (!res.ok) {
      return { ok: false, error: `provider_status_${res.status}` };
    }
    const json = (await res.json()) as { data?: { id?: string }[] };
    const models = (json.data ?? []).map((m) => m.id ?? "").filter(Boolean);
    return { ok: true, models };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.name : "network_error" };
  }
}

export function validateProviderKey(
  provider: Provider,
  apiKey: string,
): Promise<ValidationResult> {
  switch (provider) {
    case "anthropic":
      return validateAnthropicKey(apiKey);
    case "openai":
      return validateOpenAIKey(apiKey);
    case "google":
      return validateGoogleKey(apiKey);
    case "openrouter":
      return validateOpenRouterKey(apiKey);
    case "nvidia":
      return validateNvidiaKey(apiKey);
    case "ollama":
      return validateOllamaEndpoint(apiKey);
    case "deepseek":
      return validateDeepSeekKey(apiKey);
    case "qwen":
      return validateQwenKey(apiKey);
    case "zhipu":
      return validateZhipuKey(apiKey);
    case "moonshot":
      return validateMoonshotKey(apiKey);
    default: {
      // Sem `never` aqui: `Provider` agora é derivado de PROVEDORES, e a lista
      // cresce sem que este arquivo saiba. Provedor novo cadastrado antes de
      // ganhar validador devolve um erro que DIZ isso, em vez de quebrar o
      // build de quem só acrescentou uma linha na lista.
      return Promise.resolve({ ok: false, error: `unknown_provider:${provider}` });
    }
  }
}
