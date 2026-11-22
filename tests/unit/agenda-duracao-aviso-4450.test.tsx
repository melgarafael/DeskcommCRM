/**
 * O AVISO DE SUCESSO DIZ O QUE ACONTECEU (#4450).
 *
 * O mesmo PATCH serve para remarcar e para mudar só o tempo. "Agendamento
 * remarcado." depois de puxar a borda seria mentira: o início não mudou e
 * ninguém recebeu aviso de remarcação. Sem `starts_at`, o aviso é da duração.
 */
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sucesso = vi.fn();
const patch = vi.fn();

vi.mock("sonner", () => ({ toast: { success: (m: string) => sucesso(m), error: vi.fn() } }));
vi.mock("@/lib/api/client", () => ({ apiClient: { patch: (...a: unknown[]) => patch(...a) } }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));

import { useRemarcarAgendamento } from "@/hooks/agenda/useRemarcarAgendamento";

function embrulho({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  sucesso.mockReset();
  patch.mockReset().mockResolvedValue({ data: { id: "a1" } });
});

describe("aviso de sucesso do PATCH da agenda", () => {
  it("só a duração: 'Duração alterada.'", async () => {
    const { result } = renderHook(() => useRemarcarAgendamento(), { wrapper: embrulho });
    await act(async () => {
      await result.current.mutateAsync({ id: "a1", revision: 3, duration_minutes: 60 });
    });
    expect(patch).toHaveBeenCalledWith("/api/v1/agenda/agendamentos", { id: "a1", revision: 3, duration_minutes: 60 });
    expect(sucesso).toHaveBeenCalledWith("Duração alterada.");
  });

  it("com novo início continua 'Agendamento remarcado.'", async () => {
    const { result } = renderHook(() => useRemarcarAgendamento(), { wrapper: embrulho });
    await act(async () => {
      await result.current.mutateAsync({ id: "a1", starts_at: "2026-08-26T15:00:00.000Z" });
    });
    expect(sucesso).toHaveBeenCalledWith("Agendamento remarcado.");
  });
});
