import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
  definir: vi.fn(),
  refresh: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/app/actions/settings/definirLeadSubmittedCausal", () => ({
  definirLeadSubmittedCausal: deps.definir,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: deps.refresh }) }));
vi.mock("sonner", () => ({ toast: { success: deps.success, error: deps.error } }));

import { LeadSubmittedCausal } from "./_leadSubmittedCausal";

beforeEach(() => {
  vi.clearAllMocks();
  deps.definir.mockResolvedValue({ ok: true });
});
afterEach(cleanup);

describe("chave causal na tela de Conversões", () => {
  it("explica que o envio depende da mensagem em português e espanhol, sem marca fixa", () => {
    const tela = render(<LeadSubmittedCausal ligado={false} idioma="pt-BR" />);
    expect(
      screen.getByText(
        "Quando alguém clicar em um anúncio Click-to-WhatsApp e efetivamente enviar uma mensagem, o sistema poderá registrar um LeadSubmitted na Meta. Apenas abrir a conversa não gera conversão.",
      ),
    ).toBeTruthy();

    tela.rerender(<LeadSubmittedCausal ligado={false} idioma="es" />);
    expect(
      screen.getByText(
        "Cuando alguien haga clic en un anuncio Click-to-WhatsApp y llegue a enviar un mensaje, el sistema podrá registrar un LeadSubmitted en Meta. Solo abrir la conversación no genera una conversión.",
      ),
    ).toBeTruthy();
  });

  it("começa desligada e envia a decisão do administrador", async () => {
    render(<LeadSubmittedCausal ligado={false} idioma="pt-BR" />);
    const chave = screen.getByRole("switch", {
      name: "Enviar LeadSubmitted por clique CTWA à Meta",
    });
    expect(chave.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(chave);
    await waitFor(() => expect(deps.definir).toHaveBeenCalledWith(true));
    await waitFor(() => expect(deps.refresh).toHaveBeenCalledOnce());
    expect(chave.getAttribute("aria-checked")).toBe("true");
  });

  it("reverte o switch se o banco recusar a gravação", async () => {
    deps.definir.mockResolvedValue({ ok: false, error: "erro_ao_gravar" });
    render(<LeadSubmittedCausal ligado={false} idioma="pt-BR" />);
    const chave = screen.getByRole("switch", {
      name: "Enviar LeadSubmitted por clique CTWA à Meta",
    });
    fireEvent.click(chave);
    await waitFor(() => expect(deps.error).toHaveBeenCalledOnce());
    expect(chave.getAttribute("aria-checked")).toBe("false");
    expect(deps.refresh).not.toHaveBeenCalled();
  });

  it("atualiza a chave quando a organização ativa muda", () => {
    const tela = render(<LeadSubmittedCausal key="org-a" ligado={true} idioma="pt-BR" />);
    const chave = screen.getByRole("switch", {
      name: "Enviar LeadSubmitted por clique CTWA à Meta",
    });
    expect(chave.getAttribute("aria-checked")).toBe("true");
    tela.rerender(<LeadSubmittedCausal key="org-b" ligado={false} idioma="pt-BR" />);
    expect(
      screen
        .getByRole("switch", { name: "Enviar LeadSubmitted por clique CTWA à Meta" })
        .getAttribute("aria-checked"),
    ).toBe("false");
    expect(deps.definir).not.toHaveBeenCalled();
  });
});
