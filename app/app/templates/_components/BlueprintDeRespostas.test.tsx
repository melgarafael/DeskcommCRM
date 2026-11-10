/**
 * A PORTA DO BLUEPRINT (#1995): o que a tela faz com cada resposta das rotas.
 *
 * - export que dá certo baixa o arquivo e avisa quantas mídias ficaram de fora
 *   (o cabeçalho `X-Blueprint-Midias-Nao-Exportadas`);
 * - export recusado mostra a FRASE do servidor, em vez de navegar até o JSON;
 * - import mostra quantas entraram e quantas só de áudio ficaram de fora, e o
 *   409 aparece como frase no diálogo.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  post: vi.fn(),
  sucesso: vi.fn(),
  aviso: vi.fn(),
  erro: vi.fn(),
}));

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/lib/api/client", () => ({ apiClient: { post: h.post } }));
vi.mock("sonner", () => ({ toast: { success: h.sucesso, warning: h.aviso, error: h.erro } }));

import { ApiError } from "@/lib/api/types";
import { ExportarRespostasButton, ImportarRespostasDialog } from "./BlueprintDeRespostas";

function comQuery(no: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return <QueryClientProvider client={qc}>{no}</QueryClientProvider>;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  URL.createObjectURL = vi.fn(() => "blob:x");
  URL.revokeObjectURL = vi.fn();
});

describe("Exportar", () => {
  it("baixa o arquivo e diz quantas mídias ficaram de fora", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", {
        status: 200,
        headers: {
          "Content-Disposition": 'attachment; filename="respostas-rapidas-2026-11-07.json"',
          "X-Blueprint-Midias-Nao-Exportadas": "3",
        },
      }),
    );
    render(comQuery(<ExportarRespostasButton />));

    fireEvent.click(screen.getByTestId("exportar-respostas"));

    await waitFor(() => expect(h.sucesso).toHaveBeenCalledWith("Respostas rápidas exportadas."));
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(h.aviso).toHaveBeenCalledWith(
      "Mídias que ficaram de fora, porque o arquivo leva só o texto: 3.",
    );
  });

  it("recusa do servidor vira a frase dele, sem baixar nada", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: "state_conflict",
            message: "Não há respostas rápidas compartilhadas para exportar.",
          },
        }),
        { status: 409 },
      ),
    );
    render(comQuery(<ExportarRespostasButton />));

    fireEvent.click(screen.getByTestId("exportar-respostas"));

    await waitFor(() =>
      expect(h.erro).toHaveBeenCalledWith("Não há respostas rápidas compartilhadas para exportar."),
    );
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});

describe("Importar", () => {
  async function escolherEImportar(conteudo: string) {
    render(comQuery(<ImportarRespostasDialog />));
    fireEvent.click(screen.getByTestId("importar-respostas"));
    const entrada = await screen.findByLabelText("Arquivo de respostas rápidas (.json)");
    const arquivo = new File([conteudo], "r.json", { type: "application/json" });
    fireEvent.change(entrada, { target: { files: [arquivo] } });
    const botao = screen.getAllByRole("button", { name: "Importar" }).at(-1)!;
    await waitFor(() => expect(botao).not.toBeDisabled());
    fireEvent.click(botao);
  }

  it("mostra quantas entraram e quantas só de áudio ficaram de fora", async () => {
    h.post.mockResolvedValue({ data: { importadas: 4, midias_importadas: 0, sem_texto: 1 } });

    await escolherEImportar('{"formato":"respostas-rapidas.blueprint"}');

    expect(await screen.findByText("Respostas importadas como compartilhadas: 4.")).toBeTruthy();
    expect(
      screen.getByText(
        "Respostas só de áudio que ficaram de fora, porque o arquivo não leva a mídia: 1.",
      ),
    ).toBeTruthy();
    expect(h.post).toHaveBeenCalledWith("/api/v1/message-templates/importar", {
      formato: "respostas-rapidas.blueprint",
    });
  });

  it("o 409 do servidor aparece como frase no diálogo", async () => {
    const frase = "Esta organização já tem respostas rápidas compartilhadas.";
    h.post.mockRejectedValue(new ApiError(409, "state_conflict", undefined, "r", frase));

    await escolherEImportar("{}");

    expect((await screen.findByRole("alert")).textContent).toBe(frase);
  });

  it("arquivo que não é JSON não sobe", async () => {
    await escolherEImportar("isto não é json");

    expect((await screen.findByRole("alert")).textContent).toBe("O arquivo não é um JSON válido.");
    expect(h.post).not.toHaveBeenCalled();
  });
});
