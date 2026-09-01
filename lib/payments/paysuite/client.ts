/**
 * Cliente REST do PaySuite (agregador moçambicano: M-Pesa, e-Mola, cartão).
 *
 * Base confirmada em paysuite.tech/docs: `https://paysuite.tech/api/v1`.
 * Auth por Bearer token de comerciante (Settings > API Access no dashboard
 * deles) — token é POR ORGANIZAÇÃO neste produto self-host multi-tenant
 * (cada instalação/loja tem sua própria conta PaySuite), nunca uma env var
 * global.
 *
 * Não existe ambiente sandbox documentado publicamente — o `PaymentCreateInput`
 * aceita qualquer valor, mas teste com valor baixo antes de confiar.
 */

export const PAYSUITE_API_BASE = "https://paysuite.tech/api/v1";

export class PaySuiteApiError extends Error {
  status: number;
  body: string;

  constructor(status: number, body: string, message?: string) {
    super(message ?? `PaySuite API ${status}`);
    this.name = "PaySuiteApiError";
    this.status = status;
    this.body = body;
  }
}

export type PaySuiteMethod = "mpesa" | "emola" | "credit_card";

/** `payment_credentials.status` (migration 0162) — par registrado em tests/invariants/vocabulario-banco-x-typescript.test.ts. */
export type PaymentCredentialStatus = "connecting" | "healthy" | "error";

export interface PaymentCreateInput {
  /** Em MZN, formato decimal string ("100.50") — é o que a API documenta. */
  amount: string;
  /** Chave de idempotência do lado do PaySuite. Máx 50 caracteres. */
  reference: string;
  method?: PaySuiteMethod;
  /** Máx 125 caracteres. */
  description?: string;
  webhook_url?: string;
  return_url?: string;
}

export interface PaymentCreateResult {
  id: string;
  checkoutUrl: string;
}

export type PaymentStatus = "pending" | "paid" | "failed";

export interface PaymentDetails {
  id: string;
  status: PaymentStatus;
  amount: number;
  reference: string;
}

function headers(apiToken: string): HeadersInit {
  return {
    Authorization: `Bearer ${apiToken}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

async function parseBody(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/** Cria uma cobrança. Lança `PaySuiteApiError` em resposta não-2xx. */
export async function createPayment(
  apiToken: string,
  input: PaymentCreateInput,
): Promise<PaymentCreateResult> {
  const res = await fetch(`${PAYSUITE_API_BASE}/payments`, {
    method: "POST",
    headers: headers(apiToken),
    body: JSON.stringify(input),
  });

  const bodyText = await parseBody(res);
  if (!res.ok) {
    throw new PaySuiteApiError(res.status, bodyText);
  }

  let json: { data?: { id?: string; checkout_url?: string } };
  try {
    json = JSON.parse(bodyText) as typeof json;
  } catch {
    throw new PaySuiteApiError(res.status, bodyText, "PaySuite: resposta não é JSON válido.");
  }

  const id = json.data?.id;
  const checkoutUrl = json.data?.checkout_url;
  if (!id || !checkoutUrl) {
    throw new PaySuiteApiError(res.status, bodyText, "PaySuite: resposta sem id/checkout_url.");
  }

  return { id, checkoutUrl };
}

/** Consulta o status atual de um pagamento (para reconciliar quando o webhook falhar/atrasar). */
export async function getPayment(apiToken: string, paymentId: string): Promise<PaymentDetails> {
  const res = await fetch(`${PAYSUITE_API_BASE}/payments/${encodeURIComponent(paymentId)}`, {
    method: "GET",
    headers: headers(apiToken),
  });

  const bodyText = await parseBody(res);
  if (!res.ok) {
    throw new PaySuiteApiError(res.status, bodyText);
  }

  let json: { data?: PaymentDetails };
  try {
    json = JSON.parse(bodyText) as typeof json;
  } catch {
    throw new PaySuiteApiError(res.status, bodyText, "PaySuite: resposta não é JSON válido.");
  }

  if (!json.data) {
    throw new PaySuiteApiError(res.status, bodyText, "PaySuite: resposta sem data.");
  }
  return json.data;
}
