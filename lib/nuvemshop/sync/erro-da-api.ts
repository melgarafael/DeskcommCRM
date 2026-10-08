import type { HandlerResult } from "@/lib/event-log/dispatcher";
import { NuvemshopApiError } from "@/lib/nuvemshop/api-client";
import type { DepsDoSync } from "./deps";
import type { IntegracaoCarregada } from "./integracao";

const RETRY_PADRAO_MS = 2_000;

/** Tabela da spec §4.4. Erro que não é da API sobe (o dispatcher o vira `error`). */
export async function tratarErroDaApi(
  err: unknown,
  integ: IntegracaoCarregada,
  deps: DepsDoSync,
  key: string,
): Promise<HandlerResult> {
  if (!(err instanceof NuvemshopApiError)) throw err;
  if (err.status === 429) {
    return {
      consumer_key: key,
      status: "retry",
      retry_at: new Date(deps.agora().getTime() + (err.retryAfterMs ?? RETRY_PADRAO_MS)).toISOString(),
      detail: "rate_limited",
    };
  }
  if (err.status === 401 || err.status === 403) {
    await deps.desautorizar(integ);
    return { consumer_key: key, status: "skipped", detail: "desautorizada" };
  }
  return { consumer_key: key, status: "error", detail: `api_${err.status}_${err.code}` };
}
