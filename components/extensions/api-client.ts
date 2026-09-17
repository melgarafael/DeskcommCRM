export type ExtensionApiError = { code: string; message: string };

export type ExtensionApiResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      status: number;
      error: ExtensionApiError;
      /** Sem resposta HTTP: a mutação pode ter chegado e precisa de recibo. */
      uncertain: boolean;
    };

export async function requestExtensionApi<T>(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<ExtensionApiResult<T>> {
  const method = (init?.method ?? "GET").toUpperCase();
  const isMutation = method !== "GET" && method !== "HEAD";
  let response: Response;
  try {
    response = await fetch(input, { ...init, cache: "no-store" });
  } catch {
    return {
      ok: false,
      status: 0,
      uncertain: true,
      error: {
        code: "connection_failed",
        message: "A conexão caiu antes de o servidor confirmar o resultado.",
      },
    };
  }

  let body: { data?: T; error?: Partial<ExtensionApiError> } | null = null;
  try {
    body = (await response.json()) as { data?: T; error?: Partial<ExtensionApiError> };
  } catch {
    return {
      ok: false,
      status: response.status,
      uncertain: isMutation,
      error: {
        code: "unexpected_response",
        message: "O servidor respondeu em um formato inesperado. Recarregue e tente novamente.",
      },
    };
  }

  if (!response.ok || body?.data === undefined) {
    return {
      ok: false,
      status: response.status,
      uncertain: isMutation && (response.status >= 500 || response.ok),
      error: {
        code: body?.error?.code ?? "request_failed",
        message: body?.error?.message ?? "Não foi possível concluir a operação.",
      },
    };
  }

  return { ok: true, data: body.data };
}
