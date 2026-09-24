/**
 * O link da mídia do modelo se salva na aba de Templates, sem enviar nada.
 *
 * Até aqui a única porta era o painel da janela fechada, que grava o link
 * DEPOIS de um envio: para deixar o modelo pronto, o operador tinha de disparar
 * para um cliente. Os casos abaixo prendem a porta nova: o campo vem com o link
 * salvo, "Salvar link" grava na chave do endereço (`header:1`), e campo vazio
 * esquece o link.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mutateAsync = vi.fn();
const salvos: { valores: Record<string, string> } = { valores: {} };

vi.mock("@/hooks/channels/useTemplates", () => ({
  useTemplates: () => ({
    isPending: false,
    data: {
      data: {
        waba: "123",
        templates: [
          {
            name: "aviso_debriefing_adv",
            language: "pt_BR",
            status: "APPROVED",
            category: "UTILITY",
            rejectedReason: null,
            qualityScore: null,
            parameterFormat: "POSITIONAL",
            contractHash: "h",
            syncedAt: "2026-09-23T00:00:00Z",
            slots: [{ key: "1", expects: "image", onde: "cabeçalho", valueKey: "header:1" }],
            previews: [],
            savedValues: salvos.valores,
          },
        ],
      },
    },
  }),
  useSyncTemplates: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSaveTemplateValues: () => ({ mutateAsync, isPending: false }),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { TemplatesClient } from "./TemplatesClient";

describe("TemplatesClient — link da mídia salvo no modelo", () => {
  beforeEach(() => {
    mutateAsync.mockReset().mockResolvedValue({ data: { savedValues: {} } });
    salvos.valores = {};
  });

  it("salva o link na chave do endereço, sem enviar nada", async () => {
    render(<TemplatesClient />);
    const campo = screen.getByTestId("template-link-midia");
    const botao = screen.getByTestId("btn-salvar-link");
    expect(botao).toBeDisabled();

    await userEvent.type(campo, "https://exemplo.com/banner.jpg");
    expect(botao).toBeEnabled();
    await userEvent.click(botao);

    expect(mutateAsync).toHaveBeenCalledWith({
      name: "aviso_debriefing_adv",
      language: "pt_BR",
      values: { "header:1": "https://exemplo.com/banner.jpg" },
    });
  });

  it("vem com o link salvo, e campo vazio remove o link", async () => {
    salvos.valores = { "header:1": "https://exemplo.com/antigo.jpg" };
    render(<TemplatesClient />);
    const campo = screen.getByTestId("template-link-midia");
    expect(campo).toHaveValue("https://exemplo.com/antigo.jpg");

    await userEvent.clear(campo);
    const botao = screen.getByTestId("btn-salvar-link");
    expect(botao).toHaveTextContent("Remover link");
    await userEvent.click(botao);

    expect(mutateAsync).toHaveBeenCalledWith({
      name: "aviso_debriefing_adv",
      language: "pt_BR",
      values: { "header:1": "" },
    });
  });

  it("link que não é https: avisa no campo e não deixa salvar", async () => {
    render(<TemplatesClient />);
    await userEvent.type(screen.getByTestId("template-link-midia"), "http://exemplo.com/a.jpg");
    expect(screen.getByTestId("btn-salvar-link")).toBeDisabled();
    expect(screen.getByText(/comece com https/)).toBeInTheDocument();
  });

  it("link trocado por outra porta: o campo acompanha em vez de guardar o velho", () => {
    salvos.valores = { "header:1": "https://exemplo.com/x1.jpg" };
    const { rerender } = render(<TemplatesClient />);
    salvos.valores = { "header:1": "https://exemplo.com/x2.jpg" };
    rerender(<TemplatesClient />);
    expect(screen.getByTestId("template-link-midia")).toHaveValue("https://exemplo.com/x2.jpg");
    expect(screen.getByTestId("btn-salvar-link")).toBeDisabled();
  });
});
