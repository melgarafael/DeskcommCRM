// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ContatoDoNegocio } from "./ContatoDoNegocio";
import { apiClient } from "@/lib/api/client";
import { useContatosRelacionados } from "@/hooks/leads/useContatosRelacionados";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/leads/useContatosRelacionados", () => ({ useContatosRelacionados: vi.fn() }));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn(async () => undefined) }),
}));
vi.mock("@/lib/api/client", () => ({
  apiClient: { post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("./SeletorDeContato", () => ({
  SeletorDeContato: ({ onEscolher }: { onEscolher: (contato: unknown) => void }) => (
    <button
      type="button"
      onClick={() => onEscolher({ id: "33333333-3333-4333-8333-333333333333" })}
    >
      Selecionar Maria
    </button>
  ),
}));

beforeEach(() => {
  vi.mocked(useContatosRelacionados).mockReturnValue({
    data: { data: [] },
    isLoading: false,
    isError: false,
  } as never);
  vi.mocked(apiClient.post).mockResolvedValue({ data: { changed: true } });
});

describe("pessoas relacionadas no dossiê", () => {
  it("oferece inclusão no lead vazio e envia contato com função ao servidor", async () => {
    render(
      <ContatoDoNegocio
        contactId={null}
        pipelineId="funil"
        leadId="lead-1"
        podeEditarRelacionados
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Adicionar contato" }));
    fireEvent.click(screen.getByRole("button", { name: "Selecionar Maria" }));
    fireEvent.change(screen.getByLabelText("Função no negócio (opcional)"), {
      target: { value: "Financeiro" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Adicionar$/ }));
    await waitFor(() =>
      expect(apiClient.post).toHaveBeenCalledWith("/api/v1/leads/lead-1/contatos-relacionados", {
        contact_id: "33333333-3333-4333-8333-333333333333",
        papel: "Financeiro",
      }),
    );
  });

  it("não oferece edição a quem só pode ler", () => {
    render(<ContatoDoNegocio contactId={null} pipelineId="funil" leadId="lead-1" />);
    expect(screen.queryByRole("button", { name: "Adicionar contato" })).toBeNull();
  });
});
