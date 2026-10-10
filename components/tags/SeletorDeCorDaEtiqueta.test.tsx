import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SeletorDeCorDaEtiqueta } from "./SeletorDeCorDaEtiqueta";

// Issue #2718 — o gatilho existe só para quem a rota não recusa (manager+,
// requireRole em /api/v1/tags/vocabulario), e a escolha devolve o MESMO hex
// da paleta do painel de Settings, pelo nome do tom.

let papel = "manager";

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ activeOrg: { role: papel } }),
}));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

describe("SeletorDeCorDaEtiqueta (#2718)", () => {
  beforeEach(() => {
    papel = "manager";
  });
  afterEach(() => cleanup());

  it("não existe para papel abaixo de manager (a escrita recusaria)", () => {
    papel = "agent";
    render(<SeletorDeCorDaEtiqueta cor={null} onChange={vi.fn()} />);
    expect(
      screen.queryByRole("button", { name: "Cor da etiqueta" }),
    ).not.toBeInTheDocument();
  });

  it("manager abre a paleta e escolhe um tom pelo NOME, recebendo o hex", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<SeletorDeCorDaEtiqueta cor={null} onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: "Cor da etiqueta" }));
    // Os oito tons da paleta, rotulados por NOME_DO_TOM — não pelo hex.
    expect(screen.getByRole("button", { name: "Amarelo" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Âmbar" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Roxo" }));
    expect(onChange).toHaveBeenCalledWith("#ab4aba");
  });

  it("opção “Sem cor” devolve null", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<SeletorDeCorDaEtiqueta cor="#ab4aba" onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: "Cor da etiqueta" }));
    await user.click(screen.getByRole("button", { name: "Sem cor" }));
    expect(onChange).toHaveBeenCalledWith(null);
  });
});
