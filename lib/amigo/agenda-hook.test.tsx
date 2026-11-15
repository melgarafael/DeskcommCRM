import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
const deps = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: { get: deps.get } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
import { useAgendamentos, type RecorteDaGrade } from "@/hooks/agenda/useAgendamentos";

const period = { de: "2026-11-09T00:00:00Z", ate: "2026-11-16T00:00:00Z" };
const local = {
  id: "local",
  authority: "local",
  titulo: "Histórico local",
  iniciaEm: period.de,
  terminaEm: period.ate,
  situacao: "confirmed",
};
const external = {
  ...local,
  id: "external",
  authority: "amigo",
  external_status: "scheduled",
  external_connection_id: "original",
};
function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  deps.get.mockImplementation(async (url: string) => ({
    data:
      new URL(url, "https://example.test").searchParams.get("authority") === "local"
        ? [local]
        : [local, external],
  }));
});
it("local history refetch keeps its authority filter and never admits external projections", async () => {
  const scope = { ...period, authority: "local" } as RecorteDaGrade;
  const { result } = renderHook(() => useAgendamentos(scope), { wrapper: wrapper() });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(result.current.data?.map((row) => row.id)).toEqual(["local"]);
  await result.current.refetch();
  expect(result.current.data?.map((row) => row.id)).toEqual(["local"]);
  for (const [url] of deps.get.mock.calls)
    expect(new URL(String(url), "https://example.test").searchParams.get("authority")).toBe(
      "local",
    );
});
it("unfiltered legacy reads retain both histories with their actual authority and remote state", async () => {
  const { result } = renderHook(() => useAgendamentos(period), { wrapper: wrapper() });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(result.current.data).toEqual([
    expect.objectContaining({ id: "local", authority: "local" }),
    expect.objectContaining({
      id: "external",
      authority: "amigo",
      external_status: "scheduled",
      external_connection_id: "original",
    }),
  ]);
  expect(
    new URL(String(deps.get.mock.calls[0]?.[0]), "https://example.test").searchParams.has(
      "authority",
    ),
  ).toBe(false);
});
