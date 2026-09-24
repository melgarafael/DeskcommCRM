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
import { env } from "@/lib/env";

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
 *
 * O ENDEREÇO da prova é o da instalação: `OPENROUTER_BASE_URL` quando ela está
 * definida (ver `baseDaOpenRouter` abaixo). Até aqui a tela de Credenciais era
 * o único caminho que ainda batia em `openrouter.ai` fixo.
 */

/**
 * A base do OpenRouter, lida da MESMA fonte que o resto do código lê (`env`).
 *
 * O #1200 fez a variável valer para o agente publicado, para o turno do worker
 * e para a credencial da organização. Ficou de fora a validação da tela de
 * Credenciais: quem aponta a instalação para um gateway compatível via a tela
 * dizer "chave inválida" (`auth_failed_401`, vindo da openrouter.ai) enquanto o
 * agente respondia normalmente por ela.
 *
 * Duas decisões de montagem, as duas seguindo o que o repositório já faz:
 *
 *  - NADA de `/api/v1` é acrescentado. A variável pode ser a raiz ou já incluir
 *    o prefixo, e o caminho entra por concatenação — igual ao
 *    `${baseUrl ?? OPENROUTER_ENDPOINT}/chat/completions` da prova de crédito
 *    (`lib/instalacao/prova-de-credito.ts`) e ao `baseURL` do gateway
 *    (`lib/ai/gateway.ts`). Quem aponta para a raiz de um gateway que espera
 *    `/chat/completions` na raiz continua sendo atendido.
 *  - barra final é removida antes da junção, como `lib/webhooks/url-publica.ts`
 *    decidiu para o mesmo formato (`base + "/" + caminho`, sob a mesma forma:
 *    `.../api/v1/` viraria `.../api/v1//key`).
 */
function baseDaOpenRouter(): string {
  const configurada = (env.OPENROUTER_BASE_URL ?? "").trim().replace(/\/+$/, "");
  return configurada || "https://openrouter.ai/api/v1";
}

export async function validateOpenRouterKey(apiKey: string): Promise<ValidationResult> {
  try {
    const base = baseDaOpenRouter();
    const isCustomBase = !!(env.OPENROUTER_BASE_URL ?? "").trim();

    const auth = await timedFetch(`${base}/key`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (auth.status === 401 || auth.status === 403) {
      return { ok: false, error: "auth_failed_401" };
    }
    // Quando uma OPENROUTER_BASE_URL customizada está configurada (gateway OpenAI-compatível próprio,
    // vLLM, LiteLLM etc), o endpoint proprietário `/key` da OpenRouter geralmente não existe e retorna 404.
    // Nesses gateways, a autenticação e catálogo são provados via GET `/models`. (#1376)
    if (auth.status === 404 && isCustomBase) {
      const res = await timedFetch(`${base}/models`, {
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
    }
    if (!auth.ok) {
      return { ok: false, error: `provider_status_${auth.status}` };
    }

    const res = await timedFetch(`${base}/models`, {
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

/**
 * A DeepSeek é OpenAI-compatível e o `GET /models` dela EXIGE a credencial —
 * diferente do catálogo público da OpenRouter, que responde 200 para qualquer
 * string. Uma chamada já prova a chave e devolve o catálogo, então não há o
 * segundo request que a OpenRouter precisa para a lista.
 *
 * ⚠️ Por que a URL canônica fica AQUI e não é derivada de
 * `aceitaEndpointProprio`/`base_url`: a interface `ProvedorSuportado` carrega
 * só o BOOLEANO (aceita endpoint próprio), sem guardar endereço, e
 * `validateProviderKey(provider, apiKey)` não recebe `baseUrl`. Não há de onde
 * derivar sem mudar a assinatura — que arrastaria os quatro call sites e o
 * roteiro de endpoint próprio, fora deste escopo. Os outros três validadores já
 * hardcodam o endpoint de LISTAGEM deles pelo mesmo motivo; o endpoint próprio
 * é provado pela GERAÇÃO real (`lib/instalacao/prova-de-credito.ts`), não por
 * esta listagem. A raiz `https://api.deepseek.com` é a documentada pelo
 * provedor (ele também aceita `/v1`).
 */
export async function validateDeepSeekKey(apiKey: string): Promise<ValidationResult> {
  try {
    const res = await timedFetch("https://api.deepseek.com/models", {
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
    case "deepseek":
      return validateDeepSeekKey(apiKey);
    default: {
      // Sem `never` aqui: `Provider` agora é derivado de PROVEDORES, e a lista
      // cresce sem que este arquivo saiba. Provedor novo cadastrado antes de
      // ganhar validador devolve um erro que DIZ isso, em vez de quebrar o
      // build de quem só acrescentou uma linha na lista.
      return Promise.resolve({ ok: false, error: `unknown_provider:${provider}` });
    }
  }
}
