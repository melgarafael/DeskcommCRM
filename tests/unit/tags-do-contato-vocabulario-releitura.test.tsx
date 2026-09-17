import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useUpdateContact } from "@/hooks/contacts/useUpdateContact";

/**
 * A sugestão de tags do contato (#852, item 1) lê `["contact-tag-vocabulary"]`
 * com `staleTime` de 5 minutos. Gravar uma tag MUDA esse vocabulário — é a
 * escrita que o alimenta —, então quem grava precisa mandar relê-lo. Sem isto,
 * a tag criada digitando só virava sugestão para os outros contatos até cinco
 * minutos depois, e o chip recém-aplicado sumia da tela pelo filtro local do
 * componente, não porque a lista tivesse sido relida.
 */

const patch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api/client", () => ({ apiClient: { patch } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));

const CONTATO = "c-1";
let qc: QueryClient;
let invalidadas: unknown[][];

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  patch.mockReset();
  patch.mockResolvedValue({ data: { id: CONTATO, tags: ["vip"] } });
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  invalidadas = [];
  vi.spyOn(qc, "invalidateQueries").mockImplementation((filtro) => {
    invalidadas.push((filtro as { queryKey: unknown[] }).queryKey);
    return Promise.resolve();
  });
});

describe("useUpdateContact", () => {
  it("manda reler o vocabulário de tags depois de gravar", async () => {
    const { result } = renderHook(() => useUpdateContact(CONTATO), { wrapper });

    await act(() => result.current.mutateAsync({ tags: ["vip"] }));

    // Sem o orgId: a chave real é ["contact-tag-vocabulary", orgId] e o react-query
    // casa por prefixo — invalidar com o prefixo alcança toda organização em cache.
    expect(invalidadas).toContainEqual(["contact-tag-vocabulary"]);
  });

  it("segue invalidando o contato, a lista e as conversas", async () => {
    const { result } = renderHook(() => useUpdateContact(CONTATO), { wrapper });

    await act(() => result.current.mutateAsync({ tags: ["vip"] }));

    expect(invalidadas).toContainEqual(["contact", CONTATO]);
    expect(invalidadas).toContainEqual(["contacts"]);
    expect(invalidadas).toContainEqual(["conversations"]);
  });
});
