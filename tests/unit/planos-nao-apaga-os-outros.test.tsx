/**
 * Tarefas › Planos: salvar com a lista AINDA NÃO lida apagava os outros planos.
 *
 * O PATCH de `settings/task-plans` substitui `settings.task_plans` INTEIRO — a
 * tela manda a lista completa. Enquanto o GET carregava, ou depois de ele
 * falhar, a tela montava essa lista a partir de `q.data?.planos ?? []`: o `[]`
 * fingia "não há planos", e salvar um plano novo gravava SÓ ele. Os demais
 * sumiam do banco sem aviso.
 *
 * A guarda mora no cliente porque o servidor não tem como distinguir "apaguei
 * o último plano" (uso legítimo) de "a tela não sabia que havia outros".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/api/client", () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), del: vi.fn() },
}));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({
  useAssignableMembers: () => ({ data: [] }),
}));

import { apiClient } from "@/lib/api/client";
import { PlanosDeTarefa } from "@/app/app/tasks/planos/_client";

function plano(id: string, nome: string) {
  return {
    id,
    nome,
    descricao: null,
    passos: [
      {
        ordem: 1,
        titulo: "Ligar",
        descricao: null,
        vence_em_dias: 1,
        prioridade: "medium" as const,
        atribuir_a: "dono_do_lead" as const,
      },
    ],
  };
}

function montar() {
  const cliente = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={cliente}>
      <PlanosDeTarefa />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(apiClient.get).mockReset();
  vi.mocked(apiClient.patch).mockReset();
  vi.mocked(apiClient.patch).mockResolvedValue({ data: { planos: [] } } as never);
});
afterEach(() => cleanup());

describe("Tarefas › Planos não grava uma lista que a tela não leu", () => {
  it("com a leitura falhando, não deixa criar plano — e avisa em vez de dizer 'nenhum plano'", async () => {
    vi.mocked(apiClient.get).mockRejectedValue(new Error("falha de rede"));
    montar();

    await screen.findByText(/Não foi possível carregar os planos/);
    expect(screen.queryByText("Nenhum plano cadastrado ainda.")).toBeNull();

    const novo = screen.getByRole("button", { name: "Novo plano" });
    expect(novo).toBeDisabled();

    // Mesmo se o clique chegar, nada é enviado.
    fireEvent.click(novo);
    expect(screen.queryByLabelText("Nome do plano")).toBeNull();
    expect(apiClient.patch).not.toHaveBeenCalled();
  });

  it("com a leitura ainda em curso, 'Novo plano' fica desativado", async () => {
    vi.mocked(apiClient.get).mockReturnValue(new Promise(() => undefined) as never);
    montar();

    expect(screen.getByRole("button", { name: "Novo plano" })).toBeDisabled();
  });

  it("controle: com a lista lida, excluir um plano preserva o outro", async () => {
    vi.mocked(apiClient.get).mockResolvedValue({
      data: { planos: [plano("a", "Plano A"), plano("b", "Plano B")] },
    } as never);
    montar();

    await screen.findByText("Plano A");
    expect(screen.getByRole("button", { name: "Novo plano" })).toBeEnabled();

    fireEvent.click(screen.getAllByRole("button", { name: "Excluir" })[0]!);
    await waitFor(() => expect(apiClient.patch).toHaveBeenCalledTimes(1));
    const [, corpo] = vi.mocked(apiClient.patch).mock.calls[0]!;
    expect((corpo as { planos: Array<{ id: string }> }).planos.map((p) => p.id)).toEqual(["b"]);
  });
});
