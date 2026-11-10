import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useFollowupEnrollment } from "./useFollowupEnrollment";
import { useCancelFollowupEnrollment, useFollowupQueue } from "./useFollowupQueue";

const { get, post, sucesso, mostrarErro } = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  sucesso: vi.fn(),
  mostrarErro: vi.fn(),
}));
vi.mock("@/lib/api/client", () => ({ apiClient: { get, post } }));
vi.mock("sonner", () => ({ toast: { success: sucesso } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: mostrarErro }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));

const ID = "66666666-6666-4666-8666-666666666666";
let status: string;

function montar() {
  const cliente = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={cliente}>{children}</QueryClientProvider>
  );
  return renderHook(() => ({
    dossie: useFollowupEnrollment(ID),
    fila: useFollowupQueue(),
    cancelar: useCancelFollowupEnrollment(),
  }), { wrapper });
}

beforeEach(() => {
  vi.clearAllMocks();
  status = "dormente";
  get.mockImplementation(async (url: string) => url.includes("/queue?")
    ? { data: [{ id: ID, status }] }
    : { data: { id: ID, status } });
  post.mockImplementation(async () => {
    status = "cancelled";
    return { data: { id: ID, status } };
  });
});

describe("cancelamento atualiza as duas leituras do follow-up", () => {
  it("dossiê aberto e fila deixam de mostrar a espera longa após a confirmação", async () => {
    const { result } = montar();
    await waitFor(() => expect(result.current.dossie.data?.status).toBe("dormente"));
    await waitFor(() => expect(result.current.fila.data?.pages[0]?.data[0]?.status).toBe("dormente"));

    await act(async () => { await result.current.cancelar.mutateAsync(ID); });

    await waitFor(() => expect(result.current.dossie.data?.status).toBe("cancelled"));
    await waitFor(() => expect(result.current.fila.data?.pages[0]?.data[0]?.status).toBe("cancelled"));
    expect(post).toHaveBeenCalledWith(`/api/v1/ai/followups/enrollments/${ID}/cancel`, {});
    expect(sucesso).toHaveBeenCalledWith("Follow-up cancelado.");
  });

  it("recusa do servidor conserva o estado lido e mostra o erro", async () => {
    const erro = new Error("Motor ocupado");
    post.mockRejectedValueOnce(erro);
    const { result } = montar();
    await waitFor(() => expect(result.current.dossie.data?.status).toBe("dormente"));
    await waitFor(() => expect(result.current.fila.isSuccess).toBe(true));
    const leiturasAntes = get.mock.calls.length;

    await act(async () => {
      await expect(result.current.cancelar.mutateAsync(ID)).rejects.toBe(erro);
    });

    expect(result.current.dossie.data?.status).toBe("dormente");
    expect(get).toHaveBeenCalledTimes(leiturasAntes);
    expect(mostrarErro).toHaveBeenCalledWith(erro);
    expect(sucesso).not.toHaveBeenCalled();
  });
});
