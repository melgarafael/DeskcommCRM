import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const cena = vi.hoisted(() => ({
  usuario: null as { id: string } | null,
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((destino: string) => {
    throw new Error(`NEXT_REDIRECT:${destino}`);
  }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: cena.usuario } }) },
  }),
}));
vi.mock("@/lib/i18n/idiomaAnonimo", () => ({ idiomaDoVisitante: async () => "pt-BR" }));
vi.mock("@/lib/branding/saida", () => ({ marcaDaSaida: async () => ({ nome: "Marca da Revenda" }) }));

import HomePage from "./page";

async function montar() {
  return render(await HomePage());
}

beforeEach(() => {
  cena.usuario = null;
});

describe("/ — a página inicial pública", () => {
  // A verificação de um app que pede dados de conta Google abre o endereço
  // principal SEM entrar. Antes, `/` era só um redirect para o painel e o
  // revisor caía no login.
  it("sem sessão: mostra o nome da marca, o que o produto faz e os links legais", async () => {
    await montar();

    expect(screen.getByRole("heading", { level: 1, name: "Marca da Revenda" })).toBeInTheDocument();
    expect(screen.getByText(/Atendimento e vendas pelo WhatsApp/)).toBeInTheDocument();

    const politica = screen
      .getAllByRole("link", { name: "Política de Privacidade" })
      .map((a) => a.getAttribute("href"));
    expect(politica).toContain("/legal/privacy");
    expect(screen.getByRole("link", { name: "Termos de Uso" })).toHaveAttribute(
      "href",
      "/legal/terms",
    );
    expect(screen.getByRole("link", { name: "Entrar" })).toHaveAttribute("href", "/login");
  });

  it("o nome vem da marca resolvida, não de texto fixo", async () => {
    await montar();
    expect(document.body.textContent).toContain("Marca da Revenda");
  });

  it("com sessão: segue direto para o painel, como sempre foi", async () => {
    cena.usuario = { id: "11111111-1111-4111-8111-111111111111" };
    await expect(montar()).rejects.toThrow("NEXT_REDIRECT:/app");
  });
});
