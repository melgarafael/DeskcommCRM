import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, it, expect, vi } from "vitest";
import type { ReactNode } from "react";
import { useCreateTenant } from "./useCreateTenant";
const { post } = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: { post } }));

describe("criação conserva intenção entre tentativas humanas", () => {
  it("recupera mesma chave após erro e troca apenas quando o payload normalizado muda", async () => {
    post.mockRejectedValueOnce(new Error("response lost")).mockResolvedValue({ data: { id: "same" } });
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useCreateTenant(), { wrapper });
    const payload = { display_name: "Empresa", slug: "empresa", owner_email: "OWNER@invariant.test" };
    await act(async () => { await expect(result.current.mutateAsync(payload)).rejects.toThrow("response lost"); });
    await act(async () => { await result.current.mutateAsync({ ...payload, display_name: " Empresa ", owner_email: "owner@invariant.test" }); });
    expect(post.mock.calls[1]?.[2]).toEqual(post.mock.calls[0]?.[2]);
    expect(post.mock.calls[1]?.[1]).toEqual(post.mock.calls[0]?.[1]);
    await act(async () => { await result.current.mutateAsync({ ...payload, owner_email: "different@invariant.test" }); });
    expect(post.mock.calls[2]?.[2]).not.toEqual(post.mock.calls[0]?.[2]);
    expect(post.mock.calls[0]?.[2].idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    client.clear();
  });
});
