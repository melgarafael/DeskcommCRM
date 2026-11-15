/**
 * A PORTA DO BLUEPRINT DE FUNIS (#1995): o que a tela faz com cada resposta.
 *
 * - export recusado mostra a FRASE do servidor, sem baixar nada;
 * - import mostra quantos funis entraram, quantos viraram cópia e quantos já
 *   estavam aqui — e só recarrega a lista quando algo entrou;
 * - a recusa do servidor aparece como frase no diálogo.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  post: vi.fn(),
  refresh: vi.fn(),
  sucesso: vi.fn(),
  erro: vi.fn(),
}));

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/lib/api/client", () => ({ apiClient: { post: h.post } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: h.refresh }) }));
vi.mock("sonner", () => ({ toast: { success: h.sucesso, error: h.erro } }));

import { ApiError } from "@/lib/api/types";
import { BlueprintDeFunis } from "./_blueprint-de-funis";

function montar() {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <BlueprintDeFunis />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  URL.createObjectURL = vi.fn(() => "blob:x");
  URL.revokeObjectURL = vi.fn();
});

describe("Exportar funis", () => {
  it("baixa o arquivo e avisa", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", {
        status: 200,
        headers: { "Content-Disposition": 'attachment; filename="funis-2026-11-14.json"' },
      }),
    );
    montar();

    fireEvent.click(screen.getByTestId("exportar-funis"));

    await waitFor(() => expect(h.sucesso).toHaveBeenCalledWith("Funis exportados."));
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });

  it("recusa do servidor vira a frase dele, sem baixar nada", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ error: { code: "state_conflict", message: "Não há funis para exportar." } }),
        { status: 409 },
      ),
    );
    montar();

    fireEvent.click(screen.getByTestId("exportar-funis"));

    await waitFor(() => expect(h.erro).toHaveBeenCalledWith("Não há funis para exportar."));
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});

describe("Importar funis", () => {
  async function escolherEImportar(conteudo: string) {
    montar();
    fireEvent.click(screen.getByTestId("importar-funis"));
    const entrada = await screen.findByLabelText("Arquivo de funis (.json)");
    fireEvent.change(entrada, {
      target: { files: [new File([conteudo], "f.json", { type: "application/json" })] },
    });
    const botao = screen.getByRole("button", { name: "Importar" });
    await waitFor(() => expect(botao).not.toBeDisabled());
    fireEvent.click(botao);
  }

  it("mostra criados, cópias e os que já estavam aqui, e recarrega a lista", async () => {
    h.post.mockResolvedValue({ data: { importados: 2, etapas: 8, renomeados: 1, ja_existiam: 3 } });

    await escolherEImportar('{"tipo":"funis"}');

    expect(await screen.findByText("Funis criados: 2.")).toBeTruthy();
    expect(
      screen.getByText("Criados como cópia, porque já havia um funil com o mesmo nome: 1."),
    ).toBeTruthy();
    expect(
      screen.getByText("Já estavam aqui, com as mesmas etapas, e ficaram como estavam: 3."),
    ).toBeTruthy();
    expect(h.post).toHaveBeenCalledWith("/api/v1/pipelines/importar", { tipo: "funis" });
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it("reaplicar sem criar nada não recarrega a lista", async () => {
    h.post.mockResolvedValue({ data: { importados: 0, etapas: 0, renomeados: 0, ja_existiam: 1 } });

    await escolherEImportar("{}");

    expect(await screen.findByText("Funis criados: 0.")).toBeTruthy();
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("Fechar e reabrir volta ao formulário, sem o resultado anterior", async () => {
    h.post.mockResolvedValue({ data: { importados: 1, etapas: 4, renomeados: 0, ja_existiam: 0 } });

    await escolherEImportar("{}");
    // O do rodapé — o X do canto chama `onOpenChange` e limparia mesmo sem o conserto.
    const resultado = await screen.findByTestId("importar-funis-resultado");
    fireEvent.click(within(resultado).getByRole("button", { name: "Fechar" }));
    fireEvent.click(screen.getByTestId("importar-funis"));

    expect(await screen.findByLabelText("Arquivo de funis (.json)")).toBeTruthy();
    expect(screen.queryByText("Funis criados: 1.")).toBeNull();
  });

  it("a recusa do servidor aparece como frase no diálogo", async () => {
    const frase = "Este blueprint não é de funis.";
    h.post.mockRejectedValue(new ApiError(422, "validation_failed", undefined, "r", frase));

    await escolherEImportar("{}");

    expect((await screen.findByRole("alert")).textContent).toBe(frase);
  });
});
