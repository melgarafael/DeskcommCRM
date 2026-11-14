import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
  definir: vi.fn(),
  refresh: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/app/actions/settings/definirBloqueioDeChamadas", () => ({
  definirBloqueioDeChamadas: deps.definir,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: deps.refresh }) }));
vi.mock("sonner", () => ({ toast: { success: deps.success, error: deps.error } }));

import { BloqueioDeChamadas } from "./_bloqueioDeChamadas";

const CHAVE = "Bloquear chamadas recebidas";
const CAMPO = "Mensagem para quem ligou (opcional)";

beforeEach(() => {
  vi.clearAllMocks();
  deps.definir.mockResolvedValue({ ok: true });
});
afterEach(cleanup);

describe("Bloquear chamadas recebidas — mensagem a quem ligou", () => {
  it("mostra a mensagem já salva e deixa o botão desabilitado até haver mudança", () => {
    render(<BloqueioDeChamadas ligado={true} mensagem="Escreva, por favor." />);
    expect((screen.getByLabelText(CAMPO) as HTMLTextAreaElement).value).toBe("Escreva, por favor.");
    expect((screen.getByRole("button", { name: "Salvar mensagem" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("salvar a mensagem envia a chave atual e o texto digitado", async () => {
    render(<BloqueioDeChamadas ligado={true} mensagem="" />);
    fireEvent.change(screen.getByLabelText(CAMPO), { target: { value: "  Oi, escreva aqui.  " } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar mensagem" }));
    await waitFor(() => expect(deps.definir).toHaveBeenCalledWith(true, "  Oi, escreva aqui.  "));
    await waitFor(() => expect(deps.refresh).toHaveBeenCalledOnce());
    // Depois de salvar, não há mais o que salvar.
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Salvar mensagem" }) as HTMLButtonElement).disabled).toBe(true),
    );
  });

  it("ligar a chave grava o texto JÁ SALVO, não o rascunho", async () => {
    render(<BloqueioDeChamadas ligado={false} mensagem="Texto salvo" />);
    fireEvent.change(screen.getByLabelText(CAMPO), { target: { value: "rascunho ainda não salvo" } });
    fireEvent.click(screen.getByRole("switch", { name: CHAVE }));
    await waitFor(() => expect(deps.definir).toHaveBeenCalledWith(true, "Texto salvo"));
  });

  it("limpar o campo e salvar manda texto vazio (= não avisar)", async () => {
    render(<BloqueioDeChamadas ligado={true} mensagem="Texto salvo" />);
    fireEvent.change(screen.getByLabelText(CAMPO), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar mensagem" }));
    await waitFor(() => expect(deps.definir).toHaveBeenCalledWith(true, ""));
  });

  it("falha ao gravar avisa o administrador e reverte a chave", async () => {
    deps.definir.mockResolvedValue({ ok: false, error: "forbidden_role" });
    render(<BloqueioDeChamadas ligado={false} mensagem="" />);
    const chave = screen.getByRole("switch", { name: CHAVE });
    fireEvent.click(chave);
    await waitFor(() => expect(deps.error).toHaveBeenCalledOnce());
    expect(chave.getAttribute("aria-checked")).toBe("false");
  });

  it("o campo respeita o teto de 500 caracteres", () => {
    render(<BloqueioDeChamadas ligado={false} mensagem="" />);
    expect((screen.getByLabelText(CAMPO) as HTMLTextAreaElement).maxLength).toBe(500);
  });
});
