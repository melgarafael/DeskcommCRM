import "server-only";
import { z } from "zod";
import {
  amigoInputSchemas,
  amigoOperations,
  amigoResponseSchemas,
  isAmigoMutation,
  type AmigoOperation,
  type AmigoResponse,
} from "./contracts";

const ORIGIN = "https://amigobot-api.amigoapp.com.br";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

type Route = { method: "GET" | "POST" | "PUT"; path: string; pathKeys?: readonly string[] };
const routes: Record<AmigoOperation, Route> = {
  patient_search: { method: "GET", path: "/patients/exists" },
  patient_get: { method: "GET", path: "/patients/{patientId}", pathKeys: ["patientId"] },
  patient_create: { method: "POST", path: "/patients" },
  patient_update: { method: "PUT", path: "/patients/{patientId}", pathKeys: ["patientId"] },
  patient_doctors: {
    method: "GET",
    path: "/patients/{patientId}/doctors",
    pathKeys: ["patientId"],
  },
  patient_birthdays: { method: "GET", path: "/patients/birthday" },
  insurances: { method: "GET", path: "/insurances" },
  insurance_plans: {
    method: "GET",
    path: "/insurances/plans/{insurance_group_id}",
    pathKeys: ["insurance_group_id"],
  },
  insurance_products: {
    method: "GET",
    path: "/insurances/{insurance_id}/products",
    pathKeys: ["insurance_id"],
  },
  doctors: { method: "GET", path: "/doctors" },
  doctors_available: { method: "GET", path: "/doctors/available" },
  specialties: { method: "GET", path: "/doctors/specialties" },
  doctor_dates: { method: "GET", path: "/doctors/{id}/available-dates", pathKeys: ["id"] },
  attendance_create: { method: "POST", path: "/attendances" },
  attendances: { method: "GET", path: "/attendances" },
  patient_attendances: {
    method: "GET",
    path: "/attendances/{patient_id}",
    pathKeys: ["patient_id"],
  },
  attendance_cancel: { method: "PUT", path: "/attendances/cancel/{id}", pathKeys: ["id"] },
  attendance_status: { method: "PUT", path: "/attendances/{status}", pathKeys: ["status"] },
  attendance_reschedule: { method: "PUT", path: "/attendances/{id}/reschedule", pathKeys: ["id"] },
  places: { method: "GET", path: "/places" },
  events: { method: "GET", path: "/events" },
  calendar: { method: "GET", path: "/calendar" },
};

/** Mensagens locais: nunca transportar mensagens, corpos, URLs ou causas remotas. */
export class AmigoError extends Error {
  readonly code: string;
  readonly status: number;
  readonly uncertain: boolean;
  readonly retryAfterSeconds?: number;
  constructor(code: string, status: number, uncertain = false, retryAfterSeconds?: number) {
    const messages: Record<string, string> = {
      AMIGO_NOT_CONFIGURED: "Configure a credencial do Amigo.",
      AMIGO_INVALID_INPUT: "Revise os dados da operação Amigo.",
      AMIGO_UNAUTHORIZED: "A credencial do Amigo é inválida.",
      AMIGO_FORBIDDEN: "O Amigo recusou o acesso.",
      AMIGO_NOT_FOUND: "O registro não foi encontrado no Amigo.",
      AMIGO_RATE_LIMITED: "O limite de consultas do Amigo foi atingido.",
      AMIGO_REJECTED: "O Amigo recusou a operação.",
      AMIGO_UNAVAILABLE: "O Amigo está indisponível.",
      AMIGO_TIMEOUT: "O prazo de resposta do Amigo foi excedido.",
      AMIGO_INVALID_RESPONSE: "O Amigo retornou uma resposta inválida.",
      AMIGO_RESPONSE_TOO_LARGE: "A resposta do Amigo excedeu o limite permitido.",
      AMIGO_REDIRECT: "O Amigo retornou um redirecionamento não permitido.",
    };
    super(messages[code] ?? "Não foi possível concluir a operação Amigo.");
    this.name = "AmigoError";
    this.code = code;
    this.status = status;
    this.uncertain = uncertain;
    if (retryAfterSeconds !== undefined) this.retryAfterSeconds = retryAfterSeconds;
  }
}

function retryAfter(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (!value || value.length > 128) return undefined;
  const seconds = /^\d+$/.test(value)
    ? Number(value)
    : Math.ceil((Date.parse(value) - Date.now()) / 1000);
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : undefined;
}
function httpError(response: Response, mutation: boolean): AmigoError {
  const status = response.status;
  const code =
    status === 401
      ? "AMIGO_UNAUTHORIZED"
      : status === 403
        ? "AMIGO_FORBIDDEN"
        : status === 404
          ? "AMIGO_NOT_FOUND"
          : status === 429
            ? "AMIGO_RATE_LIMITED"
            : status >= 500 || status === 408
              ? "AMIGO_UNAVAILABLE"
              : "AMIGO_REJECTED";
  return new AmigoError(
    code,
    status,
    mutation && (status >= 500 || status === 408),
    retryAfter(response),
  );
}
// Cancelamento não deve aguardar um produtor remoto que deixou de responder.
function cancelBody(body: ReadableStream<Uint8Array> | null): void {
  if (body) void body.cancel().catch(() => {});
}
async function readBounded(
  response: Response,
  signal: AbortSignal,
  mutation: boolean,
): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > MAX_RESPONSE_BYTES) {
    cancelBody(response.body);
    throw new AmigoError("AMIGO_RESPONSE_TOO_LARGE", 502, mutation);
  }
  if (!response.body) throw new AmigoError("AMIGO_INVALID_RESPONSE", 502, mutation);
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (signal.aborted) {
      cancel();
      throw new AmigoError("AMIGO_TIMEOUT", 504, mutation);
    }
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        cancel();
        throw new AmigoError("AMIGO_RESPONSE_TOO_LARGE", 502, mutation);
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new AmigoError("AMIGO_INVALID_RESPONSE", 502, mutation);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

const envelope = z.object({ status: z.literal("success"), data: z.unknown() });
/**
 * Uma chamada, sem retentativas (inclusive GET). Retry-After fica disponível no erro.
 * Apenas patient_search normaliza objeto → array; os demais data preservam o JSON bruto.
 */
export async function requestAmigo(
  token: string,
  operation: AmigoOperation,
  input: unknown,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<AmigoResponse> {
  if (typeof token !== "string" || !token.trim()) throw new AmigoError("AMIGO_NOT_CONFIGURED", 503);
  if (token.length > 16_384 || /\s/.test(token)) throw new AmigoError("AMIGO_INVALID_INPUT", 400);
  if (!amigoOperations.includes(operation)) throw new AmigoError("AMIGO_INVALID_INPUT", 400);
  const parsed = amigoInputSchemas[operation].safeParse(input);
  if (!parsed.success) throw new AmigoError("AMIGO_INVALID_INPUT", 400);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000)
    throw new AmigoError("AMIGO_INVALID_INPUT", 400);
  const values = parsed.data as Record<string, unknown>;
  const route = routes[operation];
  const path = route.path.replace(/\{([^}]+)\}/g, (_, key: string) =>
    encodeURIComponent(String(values[key])),
  );
  const url = new URL(path, ORIGIN);
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || route.pathKeys?.includes(key)) continue;
    if (route.method === "GET") {
      // OpenAPI query array: form + explode (parâmetro repetido).
      for (const item of Array.isArray(value) ? value : [value])
        url.searchParams.append(key, String(item));
    } else payload[key] = value;
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  const body = Object.keys(payload).length ? JSON.stringify(payload) : undefined;
  if (body) headers["Content-Type"] = "application/json";
  const controller = new AbortController();
  const mutation = isAmigoMutation(operation);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new AmigoError("AMIGO_TIMEOUT", 504, mutation));
      controller.abort();
    }, timeoutMs);
  });
  const perform = async (): Promise<AmigoResponse> => {
    const response = await (options.fetchImpl ?? fetch)(url.toString(), {
      method: route.method,
      headers,
      body,
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
    if (controller.signal.aborted) {
      cancelBody(response.body);
      throw new AmigoError("AMIGO_TIMEOUT", 504, mutation);
    }
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      cancelBody(response.body);
      throw new AmigoError("AMIGO_REDIRECT", 502, mutation);
    }
    if (!response.ok) {
      cancelBody(response.body);
      throw httpError(response, mutation);
    }
    if (
      !/^application\/(?:[\w.-]+\+)?json(?:\s*;|$)/i.test(
        response.headers.get("content-type") ?? "",
      )
    ) {
      cancelBody(response.body);
      throw new AmigoError("AMIGO_INVALID_RESPONSE", 502, mutation);
    }
    const raw = await readBounded(response, controller.signal, mutation);
    const result = envelope.safeParse(raw);
    if (!result.success || !Object.hasOwn(result.data, "data"))
      throw new AmigoError("AMIGO_INVALID_RESPONSE", 502, mutation);
    const data = result.data.data;
    if (
      data === false &&
      (operation === "attendance_cancel" ||
        operation === "attendance_status" ||
        operation === "attendance_reschedule")
    ) {
      throw new AmigoError("AMIGO_REJECTED", 422);
    }
    if (!amigoResponseSchemas[operation].safeParse(data).success)
      throw new AmigoError("AMIGO_INVALID_RESPONSE", 502, mutation);
    return {
      status: "success",
      data: operation === "patient_search" && !Array.isArray(data) ? [data] : data,
    };
  };
  try {
    return await Promise.race([deadline, perform()]);
  } catch (error) {
    if (error instanceof AmigoError) throw error;
    throw new AmigoError("AMIGO_UNAVAILABLE", 502, mutation);
  } finally {
    clearTimeout(timer);
  }
}
