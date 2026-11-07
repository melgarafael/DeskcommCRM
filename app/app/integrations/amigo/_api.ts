import { amigoInputSchemas, amigoResponseSchemas, isAmigoMutation } from "@/lib/amigo/contracts";
import { HEADER_ORG_DA_ABA, orgDaAba } from "@/lib/auth/org-da-aba";
import { randomId } from "@/lib/random-id";
import type { AmigoOperation, Receipt } from "./_types";
let pinnedConnection: string | null = null;
export function pinAmigoConnection(id: string | null) {
  pinnedConnection = id;
}
export const BASE = "/api/v1/integrations/amigo";
export class AmigoUiError extends Error {
  constructor(
    public code: string,
    public uncertain = false,
    public safeMessage?: string,
    public status?: number,
  ) {
    super(code);
  }
}
export function errorText(error: unknown): string {
  if (error instanceof AmigoUiError) {
    if (error.uncertain)
      return "Resultado não confirmado (incerto). Confira o resultado antes de qualquer nova tentativa.";
    if (error.safeMessage) return error.safeMessage;
    const code = error.code.toLowerCase();
    if (/token|unauth|401/.test(code))
      return "Confira o token e o acesso à clínica. Um administrador pode testar a conexão novamente.";
    if (/contact_required/.test(code))
      return "Escolha o contato destinatário para consultar ou alterar este paciente.";
    if (/forbidden|403/.test(code))
      return "Seu acesso não permite esta consulta ou alteração. Peça ajuda a um administrador.";
    if (/not_configured/.test(code))
      return "A conexão precisa ser configurada por um administrador.";
    if (/valid|input|400/.test(code))
      return "Confira os campos e as seleções. A solicitação não foi aceita.";
    if (/rate|429/.test(code))
      return "O Amigo está limitando consultas. Aguarde antes de atualizar.";
  }
  return "Não foi possível consultar o Amigo. Confira a conexão e tente atualizar.";
}
/** Transporte restrito à integração. Sem retry automático, inclusive em 429/503. */
export async function amigoRequest<T>(
  path: string,
  method = "GET",
  body?: unknown,
  key?: string,
): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (pinnedConnection) headers["X-Amigo-Connection"] = pinnedConnection;
  if (method !== "GET") {
    headers["Content-Type"] = "application/json";
    headers["Idempotency-Key"] = key ?? randomId();
    const org = orgDaAba();
    if (org?.orgId) headers[HEADER_ORG_DA_ABA] = org.orgId;
  }
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
    credentials: "same-origin",
    signal: AbortSignal.timeout(45_000),
  });
  let value;
  try {
    value = await res.json();
  } catch {
    throw new AmigoUiError("invalid_response", method !== "GET");
  }
  if (!res.ok)
    throw new AmigoUiError(
      String(value?.error?.code ?? res.status),
      value?.error?.details?.uncertain === true,
      res.status === 422 && typeof value?.error?.message === "string"
        ? value.error.message.slice(0, 1000)
        : undefined,
      res.status,
    );
  if (!value || !Object.hasOwn(value, "data"))
    throw new AmigoUiError("invalid_response", method !== "GET");
  return value.data as T;
}
export async function execute(
  operation: AmigoOperation,
  input: Record<string, unknown>,
  key?: string,
  contactId?: string,
): Promise<Receipt> {
  const parsed = amigoInputSchemas[operation].safeParse(input);
  if (!parsed.success) throw new AmigoUiError("validation");
  let result: Receipt;
  try {
    result = await amigoRequest<Receipt>(
      "/execute",
      "POST",
      {
        operation,
        input: parsed.data,
        ...(key ? { operation_key: key } : {}),
        ...(contactId ? { contact_id: contactId } : {}),
      },
      key,
    );
  } catch (error) {
    if (
      isAmigoMutation(operation) &&
      (!(error instanceof AmigoUiError) || (error.status !== undefined && error.status >= 500))
    )
      throw new AmigoUiError("network", true);
    throw error;
  }
  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    !Object.hasOwn(result, "data")
  )
    throw new AmigoUiError("invalid_response", isAmigoMutation(operation));
  if (result.state === "rejected")
    throw new AmigoUiError(
      "amigo_rejected",
      false,
      "A solicitação foi recusada pelo Amigo. Confira os dados antes de fazer uma nova solicitação.",
    );
  if (
    result.uncertain ||
    (result.state && !["confirmed", "confirmada", "success"].includes(result.state))
  )
    return { ...result, uncertain: true };
  const checked = amigoResponseSchemas[operation].safeParse(result.data);
  if (!checked.success) throw new AmigoUiError("invalid_response", isAmigoMutation(operation));
  return { ...result, data: checked.data };
}
export async function read<T>(
  operation: AmigoOperation,
  input: Record<string, unknown> = {},
  contactId?: string,
): Promise<T> {
  const receipt = await execute(operation, input, undefined, contactId);
  if (receipt.uncertain) throw new AmigoUiError("uncertain", true);
  return receipt.data as T;
}
