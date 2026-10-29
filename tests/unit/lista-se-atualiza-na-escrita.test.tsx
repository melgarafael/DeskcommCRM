/**
 * A LISTA DO FUNIL SE ATUALIZA NA ESCRITA (#3172, conserto da triagem do #3252).
 *
 * A página da Lista tinha chave própria (`["leads-paginados", …]`) e nenhuma
 * escrita a invalidava: o Novo Lead e as edições pela ficha aberta na Lista só
 * invalidavam `["board", pipelineId]`. O lead criado não aparecia, e a ficha
 * mostrava o valor antigo até o F5.
 *
 * O conserto pôs a página DEBAIXO da chave do quadro, e o que se observa aqui é
 * o efeito no fio: depois da escrita, um novo GET da página. Os hooks de escrita
 * são os de produção, sem dublê — é a chave que ELES invalidam que importa.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: api }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));

import { useCreateLead } from "@/hooks/kanban/useCreateLead";
import { useLeadsPaginados } from "@/hooks/kanban/useLeadsPaginados";
import { useEditLead } from "@/hooks/kanban/useUpdateLead";

const PIPELINE = "p-1";
let titulo = "Antes";

function paginasPedidas() {
  return api.get.mock.calls.filter(([url]) =>
    String(url).startsWith(`/api/v1/pipelines/${PIPELINE}/leads?page=1`),
  ).length;
}

function montar<T>(hook: () => T) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return renderHook(hook, { wrapper });
}

beforeEach(() => {
  titulo = "Antes";
  api.get.mockReset();
  api.post.mockReset();
  api.patch.mockReset();
  api.get.mockImplementation(async () => ({
    data: [{ id: "l-1", title: titulo }],
    meta: { page: 1, per_page: 50, has_more: false },
  }));
});

describe("a Lista se atualiza depois de uma escrita no funil", () => {
  it("Novo Lead com a Lista aberta pede a página 1 de novo", async () => {
    api.post.mockResolvedValue({ data: { id: "l-2" } });
    const { result } = montar(() => ({
      lista: useLeadsPaginados(PIPELINE, 1),
      criar: useCreateLead(PIPELINE),
    }));
    await waitFor(() => expect(result.current.lista.isSuccess).toBe(true));
    expect(paginasPedidas()).toBe(1);

    await act(async () => {
      await result.current.criar.mutateAsync({ title: "Novo" } as never);
    });

    await waitFor(() => expect(paginasPedidas()).toBe(2));
  });

  it("editar pela ficha aberta na Lista traz o valor novo sem recarregar", async () => {
    api.patch.mockImplementation(async () => {
      titulo = "Depois";
      return { data: { id: "l-1", title: "Depois" } };
    });
    const { result } = montar(() => ({
      lista: useLeadsPaginados(PIPELINE, 1),
      editar: useEditLead(PIPELINE),
    }));
    await waitFor(() => expect(result.current.lista.data?.leads[0]?.title).toBe("Antes"));

    await act(async () => {
      await result.current.editar.mutateAsync({ leadId: "l-1", patch: { title: "Depois" } });
    });

    await waitFor(() => expect(result.current.lista.data?.leads[0]?.title).toBe("Depois"));
    expect(paginasPedidas()).toBe(2);
  });
});
