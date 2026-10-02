/**
 * Suspender ou reativar que NÃO mudou nada não é sucesso.
 *
 * As rotas respondem 200 `{changed:false, motivo}` quando a empresa já estava
 * no estado pedido (outro admin agiu antes, tela desatualizada). O aviso verde
 * "com sucesso" ali mente — no caso da suspensão por cobrança, o admin leria
 * "reativado" com a empresa ainda parada.
 */
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { post, toast } = vi.hoisted(() => ({
  post: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("@/lib/api/client", () => ({ apiClient: { post: (...a: unknown[]) => post(...a) } }));
vi.mock("sonner", () => ({ toast }));

import { useReactivateTenant } from "./useReactivateTenant";
import { useSuspendTenant } from "./useSuspendTenant";

function montar<T>(hook: () => T) {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return renderHook(hook, { wrapper });
}

const PEDIDO = { id: "org-1", reason: "Motivo com mais de dez letras" };

beforeEach(() => vi.clearAllMocks());

describe("suspender", () => {
  it("changed:true → sucesso", async () => {
    post.mockResolvedValue({ data: { changed: true } });
    const { result } = montar(useSuspendTenant);
    await act(async () => { await result.current.mutateAsync(PEDIDO); });
    expect(toast.success).toHaveBeenCalledWith("Tenant suspenso com sucesso");
    expect(toast.info).not.toHaveBeenCalled();
  });

  it("changed:false ja_suspensa → info com o motivo, nunca sucesso", async () => {
    post.mockResolvedValue({ data: { changed: false, motivo: "ja_suspensa" } });
    const { result } = montar(useSuspendTenant);
    await act(async () => { await result.current.mutateAsync(PEDIDO); });
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalledWith("Nada mudou", {
      description: "Esta empresa já estava suspensa.",
    });
  });

  it("changed:false org_encerrada → info com o motivo", async () => {
    post.mockResolvedValue({ data: { changed: false, motivo: "org_encerrada" } });
    const { result } = montar(useSuspendTenant);
    await act(async () => { await result.current.mutateAsync(PEDIDO); });
    expect(toast.info).toHaveBeenCalledWith("Nada mudou", {
      description: "Esta empresa foi encerrada ou anonimizada e já não opera.",
    });
  });
});

describe("reativar", () => {
  it("changed:true → sucesso", async () => {
    post.mockResolvedValue({ data: { changed: true } });
    const { result } = montar(useReactivateTenant);
    await act(async () => { await result.current.mutateAsync(PEDIDO); });
    expect(toast.success).toHaveBeenCalledWith("Tenant reativado com sucesso");
  });

  it("changed:false nao_suspensa → info com o motivo, nunca sucesso", async () => {
    post.mockResolvedValue({ data: { changed: false, motivo: "nao_suspensa" } });
    const { result } = montar(useReactivateTenant);
    await act(async () => { await result.current.mutateAsync(PEDIDO); });
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalledWith("Nada mudou", {
      description: "Esta empresa não estava suspensa.",
    });
  });

  it("changed:false suspensao_de_cobranca → aponta Dar prazo / Tornar isenta", async () => {
    post.mockResolvedValue({ data: { changed: false, motivo: "suspensao_de_cobranca" } });
    const { result } = montar(useReactivateTenant);
    await act(async () => { await result.current.mutateAsync(PEDIDO); });
    expect(toast.info).toHaveBeenCalledWith("Nada mudou", {
      description: "Esta suspensão é por falta de pagamento. Use Dar prazo ou Tornar isenta.",
    });
  });

  it("motivo desconhecido → info sem descrição inventada", async () => {
    post.mockResolvedValue({ data: { changed: false, motivo: "algo_futuro" } });
    const { result } = montar(useReactivateTenant);
    await act(async () => { await result.current.mutateAsync(PEDIDO); });
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalledWith("Nada mudou", { description: undefined });
  });
});
