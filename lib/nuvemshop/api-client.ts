/**
 * Nuvemshop REST API client.
 *
 * Handles auth header (`Authentication: bearer <token>` — note lowercase
 * "bearer", per Nuvemshop spec) and User-Agent. Throws `NuvemshopApiError` on
 * non-2xx responses with structured info for the caller.
 */

import { APP_USER_AGENT, nuvemshopApiBase, type NuvemshopEvent } from "./config";

/** Sem timeout um GET pendurado prende o evento em `processing` por 10 min. */
const TIMEOUT_DA_REQUISICAO_MS = 20_000;

export class NuvemshopApiError extends Error {
  status: number;
  code: string;
  body: string;
  /** Quanto esperar antes de tentar de novo, quando a API disse (429). */
  retryAfterMs: number | null;

  constructor(
    status: number,
    code: string,
    body: string,
    message?: string,
    retryAfterMs: number | null = null,
  ) {
    super(message ?? `Nuvemshop API ${status} (${code})`);
    this.name = "NuvemshopApiError";
    this.status = status;
    this.code = code;
    this.body = body;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface NuvemshopWebhook {
  id: number;
  event: string;
  url: string;
  created_at?: string;
  updated_at?: string;
}

export interface NuvemshopStore {
  id: number;
  name: Record<string, string> | string;
  business_name?: string;
  email?: string;
  url?: string;
  country?: string;
  main_currency?: string;
  main_language?: string;
}

/** Uma página de pedidos de uma janela de `updated_at`. */
export interface ConsultaDePedidos {
  updatedAtMin: string;
  updatedAtMax: string;
  page: number;
  perPage: number;
}

interface ApiClientOptions {
  storeId: string;
  accessToken: string;
}

export class NuvemshopApiClient {
  private readonly storeId: string;
  private readonly accessToken: string;

  constructor({ storeId, accessToken }: ApiClientOptions) {
    if (!storeId) throw new Error("NuvemshopApiClient: storeId required");
    if (!accessToken) throw new Error("NuvemshopApiClient: accessToken required");
    this.storeId = storeId;
    this.accessToken = accessToken;
  }

  private url(path: string): string {
    const trimmed = path.startsWith("/") ? path : `/${path}`;
    return `${nuvemshopApiBase()}/${encodeURIComponent(this.storeId)}${trimmed}`;
  }

  private headers(extra?: HeadersInit): HeadersInit {
    return {
      Authentication: `bearer ${this.accessToken}`,
      "User-Agent": APP_USER_AGENT,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(extra ?? {}),
    };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.url(path), {
        method,
        headers: this.headers(),
        body: body !== undefined ? JSON.stringify(body) : undefined,
        cache: "no-store",
        signal: AbortSignal.timeout(TIMEOUT_DA_REQUISICAO_MS),
      });
    } catch (err) {
      throw new NuvemshopApiError(0, "network_error", String((err as Error).message));
    }

    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      // Leitura do corpo interrompida (ex.: o AbortSignal de timeout disparou
      // depois dos cabeçalhos): mesma classe de falha de rede do fetch acima.
      throw new NuvemshopApiError(0, "network_error", String((err as Error).message));
    }

    // Corpo vazio só é sucesso numa resposta 2xx. Erro sem corpo (429/5xx/404
    // vazios) segue o caminho de erro, senão uma janela que falhou parece vazia.
    if (res.ok && (res.status === 204 || text.length === 0)) {
      return undefined as T;
    }

    if (!res.ok) {
      const code =
        res.status === 401
          ? "unauthorized"
          : res.status === 403
            ? "forbidden"
            : res.status === 404
              ? "not_found"
              : res.status === 429
                ? "rate_limited"
                : res.status >= 500
                  ? "upstream_error"
                  : "request_failed";
      const reset = Number(res.headers.get("x-rate-limit-reset"));
      const retryAfterMs = res.status === 429 && Number.isFinite(reset) && reset > 0 ? reset : null;
      throw new NuvemshopApiError(res.status, code, text, undefined, retryAfterMs);
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new NuvemshopApiError(res.status, "invalid_json", text);
    }
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  delete(path: string): Promise<void> {
    return this.request<void>("DELETE", path);
  }

  // ---- Convenience wrappers ---------------------------------------------------

  getStore(): Promise<NuvemshopStore> {
    return this.get<NuvemshopStore>("/store");
  }

  listWebhooks(): Promise<NuvemshopWebhook[]> {
    return this.get<NuvemshopWebhook[]>("/webhooks");
  }

  createWebhook(event: NuvemshopEvent, url: string): Promise<NuvemshopWebhook> {
    return this.post<NuvemshopWebhook>("/webhooks", { event, url });
  }

  deleteWebhook(id: number): Promise<void> {
    return this.delete(`/webhooks/${id}`);
  }

  /**
   * Uma página de pedidos de uma janela de `updated_at`. A Nuvemshop responde
   * 404 ("Last page is N") para página sem itens — inclusive a página 1 de uma
   * janela vazia —, então 404 aqui é lista vazia, não erro.
   */
  async listOrders(q: ConsultaDePedidos): Promise<unknown[]> {
    const params = new URLSearchParams({
      updated_at_min: q.updatedAtMin,
      updated_at_max: q.updatedAtMax,
      page: String(q.page),
      per_page: String(q.perPage),
      status: "any",
    });
    try {
      const data = await this.get<unknown>(`/orders?${params.toString()}`);
      return Array.isArray(data) ? data : [];
    } catch (err) {
      if (err instanceof NuvemshopApiError && err.status === 404) return [];
      throw err;
    }
  }

  getOrder(id: string): Promise<unknown> {
    return this.get<unknown>(`/orders/${encodeURIComponent(id)}`);
  }
}
