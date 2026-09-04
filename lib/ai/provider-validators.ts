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
 * (catálogo).
 *
 * ⚠️ `/api/v1/models` É PÚBLICO. Validar por ele não valida nada — e era o que
 * este arquivo fazia. Medido em 2026-09-02, com a chave mais falsa possível:
 *
 *     GET /api/v1/models   sem header nenhum         → 200
 *     GET /api/v1/models   Bearer sk-or-v1-...falsa  → 200
 *     GET /api/v1/key      Bearer sk-or-v1-...falsa  → 401
 *
 * O comentário anterior dizia que o catálogo responde "esta chave é aceita?"
 * do mesmo jeito que os três irmãos acima. Não responde: os outros três batem
 * em endpoints que EXIGEM credencial, este não.
 *
 * O efeito medido é o pior para quem opera: QUALQUER string era gravada com
 * `validated_at` preenchido, a tela dizia "validada" com o final da chave ao
 * lado, e a falha só aparecia no primeiro turno do agente — como
 * `runtime_error: User not found.`, mensagem que não menciona credencial
 * nenhuma. Quem depurasse isso procuraria o defeito no modelo, no provedor ou
 * no runtime; o operador tinha uma tela dizendo que a parte quebrada estava boa.
 *
 * A prova passa a ser `/api/v1/key`, que exige a credencial. O catálogo segue
 * sendo lido DEPOIS, porque a lista de modelos é o que a interface usa — e ali
 * ele é só dado, não prova. Catálogo fora do ar não recusa uma chave que já
 * provou ser válida: seria trocar um erro de credencial por um de
 * disponibilidade.
 */
export async function validateOpenRouterKey(apiKey: string): Promise<ValidationResult> {
  try {
    const auth = await timedFetch("https://openrouter.ai/api/v1/key", {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (auth.status === 401 || auth.status === 403) {
      return { ok: false, error: "auth_failed_401" };
    }
    if (!auth.ok) {
      return { ok: false, error: `provider_status_${auth.status}` };
    }

    const res = await timedFetch("https://openrouter.ai/api/v1/models", {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return { ok: true, models: [] };

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
    default: {
      // Sem `never` aqui: `Provider` agora é derivado de PROVEDORES, e a lista
      // cresce sem que este arquivo saiba. Provedor novo cadastrado antes de
      // ganhar validador devolve um erro que DIZ isso, em vez de quebrar o
      // build de quem só acrescentou uma linha na lista.
      return Promise.resolve({ ok: false, error: `unknown_provider:${provider}` });
    }
  }
}
