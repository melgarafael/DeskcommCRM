/**
 * Continuar por outro número = abrir a conversa do contato lá E assumi-la.
 *
 * Abrir e assumir são dois pedidos. Os casos prendem os desfechos: assumiu; a
 * conversa já tinha dono (409 — o comum é a conversa fechada que reabre com o
 * dono antigo, que pode ser você); e o `claim` falhou por outro motivo depois
 * de a conversa já estar aberta, que ainda assim precisa ser mostrada.
 */
import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ApiError } from "@/lib/api/types";

const { post, get, toast, showApiError } = vi.hoisted(() => ({
  post: vi.fn(),
  get: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  showApiError: vi.fn(),
}));

vi.mock("@/lib/api/client", () => ({
  apiClient: { post: (...a: unknown[]) => post(...a), get: (...a: unknown[]) => get(...a) },
}));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: (e: unknown) => showApiError(e) }));
vi.mock("@/hooks/auth/AuthProvider", () => ({ useAuth: () => ({ user: { id: "eu" } }) }));

import { useContinuarPorOutroNumero } from "./useContinuarPorOutroNumero";

const conflito = () => new ApiError(409, "conflict", undefined, "req-1");

function montar() {
  const qc = new QueryClient();
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return renderHook(() => useContinuarPorOutroNumero(), { wrapper });
}

async function continuar() {
  const { result } = montar();
  result.current.mutate({ contact_id: "c1", channel_session_id: "b" });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  return result.current.data;
}

describe("useContinuarPorOutroNumero", () => {
  beforeEach(() => {
    post.mockReset();
    get.mockReset();
    showApiError.mockReset();
    Object.values(toast).forEach((f) => f.mockReset());
    post.mockResolvedValueOnce({ data: { conversation_id: "conv-b" } });
  });

  it("abre a conversa no número escolhido e assume", async () => {
    post.mockResolvedValueOnce({});
    expect(await continuar()).toBe("conv-b");
    expect(post.mock.calls[0]).toEqual([
      "/api/v1/conversations/open-with-contact",
      { contact_id: "c1", channel_session_id: "b" },
    ]);
    expect(post.mock.calls[1]).toEqual(["/api/v1/conversations/conv-b/claim", { expected_assignee: null }]);
    expect(toast.success).toHaveBeenCalled();
  });

  it("409 com a conversa já sendo sua: segue sem aviso de conflito", async () => {
    post.mockRejectedValueOnce(conflito());
    get.mockResolvedValueOnce({ data: { assigned_to_user_id: "eu", assigned_to_user_name: "Eu" } });
    expect(await continuar()).toBe("conv-b");
    expect(toast.success).toHaveBeenCalled();
    expect(toast.info).not.toHaveBeenCalled();
  });

  it("409 com dono alheio: abre sem roubar e diz com quem está", async () => {
    post.mockRejectedValueOnce(conflito());
    get.mockResolvedValueOnce({ data: { assigned_to_user_id: "outra", assigned_to_user_name: "Ana" } });
    expect(await continuar()).toBe("conv-b");
    expect(toast.info).toHaveBeenCalledWith(expect.stringContaining("Ana"));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("claim falha por outro motivo: a conversa já aberta ainda é mostrada, com o erro", async () => {
    const erro = new ApiError(500, "internal_error", undefined, "req-2");
    post.mockRejectedValueOnce(erro);
    expect(await continuar()).toBe("conv-b");
    expect(showApiError).toHaveBeenCalledWith(erro);
    expect(toast.success).not.toHaveBeenCalled();
  });
});
