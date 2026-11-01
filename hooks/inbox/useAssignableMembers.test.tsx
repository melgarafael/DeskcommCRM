import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { get } = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("@/lib/api/client", () => ({
  apiClient: { get: (...args: unknown[]) => get(...args) },
}));

import { useAssignableMembers } from "./useAssignableMembers";

describe("useAssignableMembers", () => {
  it("compartilha uma lista, não o envelope da API, no cache usado por Financeiro", async () => {
    const members = [{ user_id: "ana", role: "agent", full_name: "Ana" }];
    get.mockResolvedValueOnce({ data: members });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useAssignableMembers(true), { wrapper });

    await waitFor(() => expect(result.current.data).toEqual(members));
    expect(get).toHaveBeenCalledWith("/api/v1/team/assignable");
    expect(queryClient.getQueryData(["team", "assignable"])).toEqual(members);
  });
});
