/**
 * O Admin Plataforma tem como trocar de tema — e por que isso merece catraca.
 *
 * Até 20/09/2026 o `ThemeToggle` só era montado por `components/shell/TopBar.tsx`,
 * a casca do TENANT. Medido na época, a superfície inteira de admin
 * (`app/(admin)`, `app/admin`, `components/admin`) tinha ZERO ocorrência de
 * `ThemeToggle`, `useTheme`, `setTheme` ou `data-theme`.
 *
 * O efeito não era "falta um botão". O atalho `mod+shift+l` é registrado DENTRO
 * do `ThemeToggle`, então sem o componente montado não havia botão NEM atalho:
 * o único caminho era sair para `/app`, trocar lá, e voltar. E quem cai no admin
 * primeiro não é um caso raro — o `install.sh` cria o dono da instalação como
 * platform admin, então é a primeira tela de muita gente numa VPS nova.
 *
 * Por que o teste é sobre a TARJA e não sobre o `AdminShell`: o `AdminShell` não
 * tem barra de topo no desktop (o único `<header>` dele é `lg:hidden`), e a tarja
 * do Modo Plataforma é o único elemento persistente do topo em todas as larguras.
 * Se alguém mover o controle para outro lugar, este teste fica vermelho e a
 * mudança passa a ser deliberada — que é o ponto.
 *
 * LIMITE DECLARADO: isto prova que o controle EXISTE e que ele cicla o tema.
 * NÃO prova que a tarja está montada em toda tela de admin — quem monta é
 * `app/admin/(protected)/layout.tsx`, pelo `AdminShell`, e guardar esse elo
 * exigiria montar um layout async que chama `requirePlatformAdmin`. É o mesmo
 * limite que `admin-shell-tooltip.test.tsx` já declara.
 *
 * Sabotagem que confirma que a guarda vigia: remover `<ThemeToggle />` de
 * `components/admin/PlatformModeBanner.tsx` deixa os dois casos vermelhos.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { PlatformModeBanner } from "@/components/admin/PlatformModeBanner";
import { ThemeProvider } from "@/lib/theme";

// Mesmo stub local de `lib/theme.test.tsx`: o jsdom não implementa matchMedia,
// e o `ThemeProvider` o consulta para resolver o tema "system".
window.matchMedia = vi.fn().mockImplementation((query: string) => ({
  matches: false,
  media: query,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
})) as unknown as typeof window.matchMedia;

afterEach(() => {
  cleanup();
  try {
    window.localStorage.clear();
  } catch {
    // localStorage indisponível no ambiente — o provider já degrada sozinho.
  }
});

const tarja = () =>
  render(
    <ThemeProvider>
      <PlatformModeBanner />
    </ThemeProvider>,
  );

describe("Admin Plataforma — troca de tema", () => {
  it("a tarja do Modo Plataforma oferece o controle de tema", () => {
    tarja();
    // O `aria-label` do `ThemeToggle` começa por "Tema: " e traz o estado
    // atual. Casar pelo prefixo em vez do texto inteiro evita que renomear o
    // estado ("system" → "sistema") derrube a guarda por motivo errado.
    expect(screen.getByRole("button", { name: /^Tema: /i })).toBeInTheDocument();
  });

  it("o controle CICLA de fato — não é um botão decorativo", async () => {
    // Sem isto, um `<Button>` sem `onClick` passaria no caso acima: a guarda
    // mediria a presença de um elemento, não a existência da capacidade.
    const usuario = userEvent.setup();
    tarja();

    const botao = screen.getByRole("button", { name: /^Tema: /i });
    const antes = botao.getAttribute("aria-label");

    await usuario.click(botao);

    const depois = screen
      .getByRole("button", { name: /^Tema: /i })
      .getAttribute("aria-label");
    expect(depois).not.toBe(antes);
  });
});
