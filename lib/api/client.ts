import type { ZodSchema } from "zod";

import { ApiError, type ApiErrorBody } from "@/lib/api/types";
import { randomId } from "@/lib/random-id";

type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export type RequestOpts = {
  schema?: ZodSchema<unknown>;
  idempotencyKey?: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
  signal?: AbortSignal;
};

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;
const RETRYABLE_STATUSES = new Set([429, 503]);
const MUTATING_METHODS = new Set<HttpMethod>(["POST", "PATCH", "PUT", "DELETE"]);

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function backoffMs(attempt: number): number {
  const base = 200 * Math.pow(2, attempt - 1);
  const jitter = Math.random() * 100 - 50;
  return Math.max(0, Math.round(base + jitter));
}

function parseRetryAfterSeconds(value: string | null): number | null {
  if (!value) return null;
  const n = parseInt(value, 10);
  if (Number.isNaN(n) || n <= 0) return null;
  return n;
}

function synthesizeCode(status: number): string {
  if (status >= 500) return "internal_error";
  if (status === 429) return "rate_limited";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status >= 400) return "unknown_error";
  return "unknown_error";
}

function combineSignals(signals: Array<AbortSignal | undefined>): AbortSignal {
  const controller = new AbortController();
  for (const sig of signals) {
    if (!sig) continue;
    if (sig.aborted) {
      controller.abort(sig.reason);
      break;
    }
    sig.addEventListener(
      "abort",
      () => controller.abort(sig.reason),
      { once: true },
    );
  }
  return controller.signal;
}

async function readBodySafe(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof (value as { error: unknown }).error === "object" &&
    (value as { error: unknown }).error !== null
  );
}

async function request<T>(
  method: HttpMethod,
  path: string,
  body: unknown,
  opts: RequestOpts = {},
): Promise<T> {
  const requestId = randomId();
  const headers: Record<string, string> = {
    Accept: "application/json",
    "X-Request-Id": requestId,
    ...(opts.headers ?? {}),
  };

  if (body !== undefined && body !== null) {
    headers["Content-Type"] ??= "application/json";
  }

  if (MUTATING_METHODS.has(method)) {
    headers["Idempotency-Key"] ??= opts.idempotencyKey ?? randomId();
  }

  const serializedBody =
    body === undefined || body === null ? undefined : JSON.stringify(body);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
    const signal = combineSignals([timeoutController.signal, opts.signal]);

    try {
      const res = await fetch(path, {
        method,
        headers,
        body: serializedBody,
        credentials: "same-origin",
        signal,
      });

      const responseRequestId = res.headers.get("X-Request-Id") ?? requestId;

      if (res.ok) {
        const parsed = (await readBodySafe(res)) as T;
        if (opts.schema) {
          return opts.schema.parse(parsed) as T;
        }
        return parsed;
      }

      // Retry on 429/503
      if (RETRYABLE_STATUSES.has(res.status) && attempt < MAX_ATTEMPTS) {
        const retryAfter = parseRetryAfterSeconds(res.headers.get("Retry-After"));
        const delay = retryAfter !== null ? retryAfter * 1000 : backoffMs(attempt);
        await sleep(delay, opts.signal);
        continue;
      }

      // Non-retry error: parse and throw
      const errBody = await readBodySafe(res);
      if (isApiErrorBody(errBody)) {
        const e = errBody.error;
        throw new ApiError(
          res.status,
          e.code ?? synthesizeCode(res.status),
          e.details,
          e.request_id ?? responseRequestId,
          e.message,
        );
      }
      throw new ApiError(
        res.status,
        synthesizeCode(res.status),
        undefined,
        responseRequestId,
        typeof errBody === "string" && errBody.length > 0
          ? errBody
          : `HTTP ${res.status}`,
      );
    } catch (err) {
      // ApiError thrown above for non-retryable: propagate immediately
      if (err instanceof ApiError) {
        throw err;
      }
      // Caller-provided signal aborted: propagate without retry
      if (opts.signal?.aborted) {
        throw err;
      }
      // Network error / timeout — retry
      lastError = err;
      if (attempt < MAX_ATTEMPTS) {
        await sleep(backoffMs(attempt), opts.signal);
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  // Exhausted retries on retryable status: throw a synthetic ApiError
  throw lastError ??
    new ApiError(
      503,
      "service_unavailable",
      undefined,
      requestId,
      "Max retries exhausted",
    );
}

export const apiClient = {
  get<T>(path: string, opts?: RequestOpts): Promise<T> {
    return request<T>("GET", path, undefined, opts);
  },
  post<T>(path: string, body: unknown, opts?: RequestOpts): Promise<T> {
    return request<T>("POST", path, body, opts);
  },
  patch<T>(path: string, body: unknown, opts?: RequestOpts): Promise<T> {
    return request<T>("PATCH", path, body, opts);
  },
  put<T>(path: string, body: unknown, opts?: RequestOpts): Promise<T> {
    return request<T>("PUT", path, body, opts);
  },
  delete<T>(path: string, opts?: RequestOpts): Promise<T> {
    return request<T>("DELETE", path, undefined, opts);
  },
};
