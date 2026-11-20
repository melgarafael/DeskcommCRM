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

beforeEach(() => {
  vi.clearAllMocks();
  deps.definir.mockResolvedValue({ ok: true });
});
afterEach(cleanup);

describe("Bloquear chamadas recebidas — a tela", () => {
  it("ligar a chave grava e atualiza a tela", async () => {
    render(<BloqueioDeChamadas ligado={false} />);
    const chave = screen.getByRole("switch", { name: CHAVE });
    fireEvent.click(chave);
    await waitFor(() => expect(deps.definir).toHaveBeenCalledWith(true));
    await waitFor(() => expect(deps.refresh).toHaveBeenCalledOnce());
    expect(chave.getAttribute("aria-checked")).toBe("true");
  });

  it("desligar a chave grava false", async () => {
    render(<BloqueioDeChamadas ligado={true} />);
    fireEvent.click(screen.getByRole("switch", { name: CHAVE }));
    await waitFor(() => expect(deps.definir).toHaveBeenCalledWith(false));
  });

  it("falha ao gravar avisa o administrador e reverte a chave", async () => {
    deps.definir.mockResolvedValue({ ok: false, error: "forbidden_role" });
    render(<BloqueioDeChamadas ligado={false} />);
    const chave = screen.getByRole("switch", { name: CHAVE });
    fireEvent.click(chave);
    await waitFor(() => expect(deps.error).toHaveBeenCalledOnce());
    expect(chave.getAttribute("aria-checked")).toBe("false");
  });
});
