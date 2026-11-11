import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
  definir: vi.fn(),
  refresh: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/app/actions/settings/definirOrigemPorHorario", () => ({
  definirOrigemPorHorario: deps.definir,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: deps.refresh }) }));
vi.mock("sonner", () => ({ toast: { success: deps.success, error: deps.error } }));

import { OrigemPorHorario } from "./_origemPorHorario";

const ROTULO = "Deduzir a origem do site pelo horário do clique";

beforeEach(() => {
  vi.clearAllMocks();
  deps.definir.mockResolvedValue({ ok: true });
});
afterEach(cleanup);

describe("a chave da origem pelo horário na tela de Conversões (doc 259)", () => {
  it("diz que é palpite, em português e em espanhol", () => {
    const tela = render(<OrigemPorHorario ligada={false} idioma="pt-BR" />);
    expect(screen.getByText(/É um palpite, não uma prova/)).toBeTruthy();

    tela.rerender(<OrigemPorHorario ligada={false} idioma="es" />);
    expect(screen.getByText("Deducir el origen del sitio por la hora del clic")).toBeTruthy();
    expect(screen.getByText(/Es una suposición, no una prueba/)).toBeTruthy();
  });

  it("começa desligada e envia a decisão do administrador", async () => {
    render(<OrigemPorHorario ligada={false} idioma="pt-BR" />);
    const chave = screen.getByRole("switch", { name: ROTULO });
    expect(chave.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(chave);
    await waitFor(() => expect(deps.definir).toHaveBeenCalledWith(true));
    await waitFor(() => expect(deps.refresh).toHaveBeenCalledOnce());
    expect(chave.getAttribute("aria-checked")).toBe("true");
  });

  it("reverte a chave se a gravação falhar", async () => {
    deps.definir.mockResolvedValue({ ok: false, error: "erro_ao_gravar" });
    render(<OrigemPorHorario ligada={false} idioma="pt-BR" />);
    const chave = screen.getByRole("switch", { name: ROTULO });
    fireEvent.click(chave);
    await waitFor(() => expect(deps.error).toHaveBeenCalledOnce());
    expect(chave.getAttribute("aria-checked")).toBe("false");
  });
});
