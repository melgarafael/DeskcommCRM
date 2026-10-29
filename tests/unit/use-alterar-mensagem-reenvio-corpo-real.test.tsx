/**
 * O aviso do reenvio recusado lido pelo CLIENTE DE VERDADE (`apiClient`), com
 * só o `fetch` como dublê, devolvendo o corpo na forma que a rota responde
 * (`ok(message)` → `{ data: { ... } }`). Um dublê do `apiClient` que inventa a
 * forma da resposta aprovou um aviso que nunca aparecia.
 */
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const toastErro = vi.fn();
vi.mock("sonner", () => ({ toast: { error: (...a: unknown[]) => toastErro(...a), success: vi.fn() } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));

import { useAlterarMensagem } from "@/hooks/inbox/useAlterarMensagem";

function respostaDaRota(status: string, errorCode: string | null): Response {
  return new Response(JSON.stringify({ data: { id: "m1", status, error_code: errorCode } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function reenviar(): Promise<void> {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  const { result } = renderHook(() => useAlterarMensagem("conv-1"), { wrapper });
  await act(async () => {
    await result.current.reenviar.mutateAsync({ id: "m1", confirmado: false }).catch(() => undefined);
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  toastErro.mockReset();
});

describe("reenvio recusado de novo, pelo apiClient real", () => {
  it("corpo { data: { status: 'failed' } } dispara o aviso com o motivo", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => respostaDaRota("failed", "channel_disabled")));
    await reenviar();
    expect(toastErro).toHaveBeenCalledTimes(1);
    expect(toastErro.mock.calls[0]?.[0]).toBe("A mensagem não saiu de novo.");
  });

  it("corpo { data: { status: 'queued' } } não avisa", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => respostaDaRota("queued", null)));
    await reenviar();
    expect(toastErro).not.toHaveBeenCalled();
  });
});
