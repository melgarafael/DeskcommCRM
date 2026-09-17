/**
 * A porta da rotação na TELA.
 *
 * O teste de rota prova que o PATCH funciona; este prova que o operador
 * alcança: o card ganha o botão de editar, ele abre com o nome atual, e
 * salvar manda a chave nova para o PATCH. E, o que é o ponto da correção, o
 * botão continua habilidoso quando a chave está EM USO — é justamente aí que
 * "excluir e recriar" estava barrado.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import { CredentialCard } from "@/app/app/ai/credentials/_components/CredentialCard";
import type { CredentialRow } from "@/hooks/ai/useCredentials";

const api = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn(), post: vi.fn(), delete: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: api }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), loading: vi.fn(() => "t"), dismiss: vi.fn() },
}));
vi.mock("@/app/app/ai/credentials/_actions", () => ({
  refreshCredentialsView: vi.fn(async () => {}),
}));

let client: QueryClient;

const credencial: CredentialRow = {
  id: "22222222-2222-4222-8222-222222222222",
  organization_id: "11111111-1111-4111-8111-111111111111",
  provider: "anthropic",
  label: "Produção",
  api_key_last4: "ABCD",
  validated_at: new Date().toISOString(),
  validation_error: null,
  models_available: ["claude-x"],
  is_active: true,
  created_by: "actor",
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

function montar(usageCount: number) {
  return render(
    <IdiomaProvider locale="pt-BR">
      <QueryClientProvider client={client}>
        <CredentialCard credential={credencial} canWrite usageCount={usageCount} />
      </QueryClientProvider>
    </IdiomaProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  api.patch.mockResolvedValue({ data: credencial });
});
afterEach(() => {
  cleanup();
  client.clear();
});

describe("CredentialCard — editar/rotacionar", () => {
  it("mesmo em uso, o botão de editar está disponível e salva a chave nova", async () => {
    montar(3);

    const editar = screen.getByRole("button", { name: /editar credencial/i });
    expect(editar).toBeEnabled();
    fireEvent.click(editar);

    // Abre com o nome atual — editar não é recriar.
    const campoNome = await screen.findByLabelText("Nome");
    expect((campoNome as HTMLInputElement).value).toBe("Produção");

    fireEvent.change(screen.getByLabelText(/nova chave/i), {
      target: { value: "sk-ant-api03-NOVA-1234567890" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^salvar$/i }));

    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith(
        `/api/v1/ai/credentials/${credencial.id}`,
        { api_key: "sk-ant-api03-NOVA-1234567890" },
      ),
    );
  });

  it("só renomear manda apenas o rótulo — não gira a chave", async () => {
    montar(0);

    fireEvent.click(screen.getByRole("button", { name: /editar credencial/i }));
    const campoNome = await screen.findByLabelText("Nome");
    fireEvent.change(campoNome, { target: { value: "Produção 2" } });
    fireEvent.click(screen.getByRole("button", { name: /^salvar$/i }));

    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith(
        `/api/v1/ai/credentials/${credencial.id}`,
        { label: "Produção 2" },
      ),
    );
  });

  it("sem mudança, salvar fica desabilitado (não há requisição vazia)", async () => {
    montar(0);
    fireEvent.click(screen.getByRole("button", { name: /editar credencial/i }));
    await screen.findByLabelText("Nome");
    expect(screen.getByRole("button", { name: /^salvar$/i })).toBeDisabled();
    expect(api.patch).not.toHaveBeenCalled();
  });
});
