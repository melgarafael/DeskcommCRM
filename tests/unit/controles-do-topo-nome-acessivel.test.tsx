import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UserMenu } from "@/components/shell/UserMenu";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";

const { user } = vi.hoisted(() => ({
  user: {
    full_name: "Ana Silva" as string | null,
    email: "ana@exemplo.invalid",
    avatar_url: null,
    is_platform_admin: false,
  },
}));

// Só a identidade e os efeitos externos são substituídos. Os botões, o
// AvatarFallback, os menus Radix e a tradução permanecem reais.
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useUser: () => user,
  useAuth: () => ({ signOut: vi.fn() }),
}));
vi.mock("@/app/actions/settings/trocarIdioma", () => ({ trocarIdioma: vi.fn() }));
vi.mock("@/components/theme/theme-toggle", () => ({ ThemeToggle: () => null }));

afterEach(cleanup);

describe.each(["pt-BR", "es"])("controles do topo em %s", (locale) => {
  it("o nome acessível do idioma inclui o código que aparece no botão", () => {
    render(<IdiomaProvider locale={locale}><UserMenu /></IdiomaProvider>);

    const seletor = screen.getByTestId("seletor-de-idioma");
    const textoVisivel = seletor.textContent!.trim();
    expect(textoVisivel).not.toBe("");
    expect(seletor).toHaveAccessibleName(expect.stringContaining(textoVisivel));
  });

  it.each([
    ["Ana Silva", "ana@exemplo.invalid", "AS"],
    ["  Carlos  ", "carlos@exemplo.invalid", "C"],
    [null, "teste@exemplo.invalid", "TE"],
  ])("o nome do menu inclui as iniciais visíveis (%s)", (full_name, email, sigla) => {
    user.full_name = full_name;
    user.email = email!;
    render(<IdiomaProvider locale={locale}><UserMenu /></IdiomaProvider>);

    const botao = screen.getByText(sigla!).closest("button");
    expect(botao).toHaveAccessibleName(expect.stringContaining(sigla!));
  });
});
