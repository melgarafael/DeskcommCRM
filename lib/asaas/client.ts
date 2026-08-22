/**
 * Asaas REST API client.
 *
 * Auth por header `access_token: <chave>` (não Bearer — é assim que a Asaas
 * espera). Mesmo formato de erro estruturado de `NuvemshopApiError`, para o
 * chamador decidir retry/superfície sem parsear string.
 */

import { env } from "@/lib/env";
import { asaasApiBase } from "./config";

export class AsaasApiError extends Error {
  status: number;
  code: string;
  body: string;

  constructor(status: number, code: string, body: string, message?: string) {
    super(message ?? `Asaas API ${status} (${code})`);
    this.name = "AsaasApiError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export interface AsaasCustomer {
  id: string;
  name: string;
  email?: string;
  cpfCnpj?: string;
}

export type AsaasBillingType = "PIX" | "BOLETO" | "CREDIT_CARD" | "UNDEFINED";
export type AsaasCycle = "MONTHLY" | "YEARLY";

export interface AsaasSubscription {
  id: string;
  customer: string;
  status: string;
  value: number;
  cycle: AsaasCycle;
  nextDueDate: string;
}

export interface AsaasPayment {
  id: string;
  subscription?: string;
  customer: string;
  status: string;
  value: number;
  dueDate: string;
  invoiceUrl?: string;
}

class AsaasApiClient {
  private headers(): HeadersInit {
    return {
      access_token: env.ASAAS_API_KEY,
      "Content-Type": "application/json",
      "User-Agent": "DeskcommCRM/Genesisia-Contabilidade",
    };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${asaasApiBase()}${path}`, {
        method,
        headers: this.headers(),
        body: body !== undefined ? JSON.stringify(body) : undefined,
        cache: "no-store",
      });
    } catch (err) {
      throw new AsaasApiError(0, "network_error", String((err as Error).message));
    }

    const text = await res.text();
    if (!res.ok) {
      const code =
        res.status === 401
          ? "unauthorized"
          : res.status === 404
            ? "not_found"
            : res.status === 429
              ? "rate_limited"
              : res.status >= 500
                ? "upstream_error"
                : "request_failed";
      throw new AsaasApiError(res.status, code, text);
    }

    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new AsaasApiError(res.status, "invalid_json", text);
    }
  }

  createCustomer(input: { name: string; email?: string; cpfCnpj: string }): Promise<AsaasCustomer> {
    return this.request<AsaasCustomer>("POST", "/customers", input);
  }

  createSubscription(input: {
    customer: string;
    billingType: AsaasBillingType;
    value: number;
    cycle: AsaasCycle;
    nextDueDate: string;
    /** Amarra a assinatura Asaas ao tenant local — resolvido de volta no webhook, nunca do body dele. */
    externalReference: string;
  }): Promise<AsaasSubscription> {
    return this.request<AsaasSubscription>("POST", "/subscriptions", input);
  }

  getSubscription(id: string): Promise<AsaasSubscription> {
    return this.request<AsaasSubscription>("GET", `/subscriptions/${encodeURIComponent(id)}`);
  }
}

export const asaasClient = new AsaasApiClient();
