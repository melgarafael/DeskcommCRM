/**
 * Upload de imagem da resposta rápida (#2526) invalida `["message-templates"]`.
 *
 * Na prova pela tela do PR #2704, editar um template subindo imagem deixou a
 * lista em "Imagens 4" (eram 5 no banco) até recarregar: o caminho de edição
 * invalidava ANTES dos uploads. A invalidação mora no hook, que os dois
 * caminhos (criar e editar) usam.
 */
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";

import { useUploadTemplateMedia } from "@/hooks/templates/useUploadTemplateMedia";

it("upload que entrou invalida a lista de respostas rápidas", async () => {
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    status: 201,
    json: async () => ({ data: { midias: [] } }),
  })) as never;
  const qc = new QueryClient();
  const invalidar = vi.spyOn(qc, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );

  const { result } = renderHook(() => useUploadTemplateMedia(), { wrapper });
  await result.current.mutateAsync({ templateId: "tpl-1", file: new File([new Uint8Array([1])], "a.jpg") });

  await waitFor(() => expect(invalidar).toHaveBeenCalledWith({ queryKey: ["message-templates"] }));
});
