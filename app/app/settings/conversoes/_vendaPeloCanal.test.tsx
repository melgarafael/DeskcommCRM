import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
  definir: vi.fn(),
  refresh: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/app/actions/settings/definirVendaPeloCanal", () => ({
  definirVendaPeloCanal: deps.definir,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: deps.refresh }) }));
vi.mock("sonner", () => ({ toast: { success: deps.success, error: deps.error } }));

import { VendaPeloCanal } from "./_vendaPeloCanal";

const ROTULO = "Enviar vendas pelo canal da conversa";

beforeEach(() => {
  vi.clearAllMocks();
  deps.definir.mockResolvedValue({ ok: true });
});
afterEach(cleanup);

describe("a chave da venda pelo canal na tela de Conversões (#4552)", () => {
  it("com um canal que envia a venda, oferece a chave e grava a decisão", async () => {
    render(<VendaPeloCanal ligada={false} idioma="pt-BR" temCanalQueEnvia />);
    const chave = screen.getByRole("switch", { name: ROTULO });
    fireEvent.click(chave);
    await waitFor(() => expect(deps.definir).toHaveBeenCalledWith(true));
    expect(screen.queryByText(/Indisponível/)).toBeNull();
  });

  it("sem canal que envie e com a chave desligada, não oferece a chave e aponta a conexão direta", () => {
    render(<VendaPeloCanal ligada={false} idioma="pt-BR" temCanalQueEnvia={false} />);
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getByText(/Indisponível: nenhum canal desta organização/)).toBeTruthy();
    expect(screen.getByText(/conexão direta com a Meta/)).toBeTruthy();
  });

  it("sem canal que envie mas com a chave já ligada, mantém a chave para desligar e avisa", async () => {
    render(<VendaPeloCanal ligada idioma="pt-BR" temCanalQueEnvia={false} />);
    const chave = screen.getByRole("switch", { name: ROTULO });
    expect(chave.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("status").textContent).toMatch(/nada sai enquanto isto estiver ligado/);
    fireEvent.click(chave);
    await waitFor(() => expect(deps.definir).toHaveBeenCalledWith(false));
  });

  it("explica em espanhol quando não há canal que envie", () => {
    render(<VendaPeloCanal ligada={false} idioma="es" temCanalQueEnvia={false} />);
    expect(screen.getByText(/No disponible: ningún canal de esta organización/)).toBeTruthy();
  });

  it("sem informar o canal, a chave continua à mostra", () => {
    render(<VendaPeloCanal ligada={false} idioma="pt-BR" />);
    expect(screen.getByRole("switch", { name: ROTULO })).toBeTruthy();
  });
});
