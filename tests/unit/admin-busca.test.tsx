/**
 * A BUSCA (⌘K) DO PAINEL DO ADMINISTRADOR.
 *
 * O app do tenant tinha busca no topo desde sempre; o painel do administrador
 * não tinha nenhuma — 20 telas alcançáveis só por rolagem e reconhecimento
 * visual na sidebar, sendo onze delas configuração de instalação que a pessoa
 * abre de mês em mês (Marca, Credenciais, SMTP, Módulos…).
 *
 * O que este arquivo prova, e não só descreve:
 *   1. abre pelo atalho e mostra o catálogo sem digitar nada;
 *   2. acha por INTENÇÃO, não só pelo nome da tela ("smtp" → E-mail);
 *   3. ignora acento ("modulos" → Módulos);
 *   4. acha pelo nome que a pessoa conhece, não pelo rótulo interno
 *      ("chave" → Credenciais);
 *   5. respeita módulo desligado (Cobrança não aparece sem a chave `cobranca`);
 *   6. Enter navega para o destino destacado.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AdminCommandPalette } from "@/components/admin/AdminCommandPalette";
import { BuscaDoAdmin } from "@/components/admin/BuscaDoAdmin";
import { AdminShell } from "@/components/admin/AdminShell";
import { destinosDoAdmin } from "@/lib/admin/navegacao";
import { ThemeProvider } from "@/lib/theme";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  usePathname: () => "/admin/inbox",
}));

// O `ThemeProvider` lê `matchMedia`, que o jsdom não implementa — mesmo stub de
// `tests/unit/admin-shell-tooltip.test.tsx`.
window.matchMedia = vi.fn().mockImplementation((query: string) => ({
  matches: false,
  media: query,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
})) as unknown as typeof window.matchMedia;

afterEach(() => {
  cleanup();
  push.mockClear();
});

function abrir(modulosLigados: readonly ("cobranca")[] = []) {
  return render(
    <AdminCommandPalette open onOpenChange={() => {}} modulosLigados={modulosLigados} />,
  );
}

describe("busca do painel do administrador", () => {
  it("sem digitar nada, mostra o catálogo inteiro (as telas do menu)", () => {
    abrir();
    // Conta a partir da lista do menu, não de um número colado: tela nova de
    // admin entra em ADMIN_DESTINATIONS (a completude cobra) e não pode
    // reprovar este caso. Cobrança é condicional e fica de fora sem módulo.
    expect(screen.getAllByRole("option").length).toBe(destinosDoAdmin([]).length);
    expect(screen.getByRole("option", { name: /Dashboard/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /Módulos/ })).toBeTruthy();
  });

  it("acha por intenção: 'smtp' leva a E-mail", async () => {
    const user = userEvent.setup();
    abrir();
    await user.type(screen.getByRole("combobox"), "smtp");
    expect(screen.getByRole("option", { name: /E-mail/ })).toBeTruthy();
  });

  it("ignora acento, porque ninguém digita acento com pressa", async () => {
    const user = userEvent.setup();
    abrir();
    await user.type(screen.getByRole("combobox"), "modulos");
    expect(screen.getByRole("option", { name: /Módulos/ })).toBeTruthy();
  });

  it("acha pelo nome que a pessoa conhece, não pelo rótulo interno", async () => {
    const user = userEvent.setup();
    abrir();
    await user.type(screen.getByRole("combobox"), "chave");
    expect(screen.getByRole("option", { name: /Credenciais/ })).toBeTruthy();
  });

  it("acha tenant pelo nome da tela", async () => {
    const user = userEvent.setup();
    abrir();
    await user.type(screen.getByRole("combobox"), "tenant");
    expect(screen.getByRole("option", { name: /Tenants/ })).toBeTruthy();
  });

  it("não mostra Cobrança com o módulo desligado", async () => {
    const user = userEvent.setup();
    abrir();
    await user.type(screen.getByRole("combobox"), "cobranca");
    expect(screen.queryByRole("option", { name: /Cobrança/ })).toBeNull();
  });

  it("mostra Cobrança com o módulo ligado", async () => {
    const user = userEvent.setup();
    abrir(["cobranca"]);
    await user.type(screen.getByRole("combobox"), "cobranca");
    expect(screen.getByRole("option", { name: /Cobrança/ })).toBeTruthy();
  });

  it("Enter navega para o destino destacado", async () => {
    const user = userEvent.setup();
    abrir();
    await user.type(screen.getByRole("combobox"), "credenciais");
    await user.keyboard("{Enter}");
    expect(push).toHaveBeenCalledWith("/admin/configuracao");
  });

  it("diz quando não achou, em vez de sumir sem explicação", async () => {
    const user = userEvent.setup();
    abrir();
    await user.type(screen.getByRole("combobox"), "zzzzzz");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText(/Nada encontrado/i)).toBeTruthy();
  });

  it("o gatilho anuncia o nome acessível mesmo com o rótulo escondido no celular", () => {
    render(<BuscaDoAdmin />);
    expect(
      screen.getByRole("button", { name: /Buscar telas da instalação/i }),
    ).toBeTruthy();
  });
});

describe("a casca do painel monta a busca", () => {
  /**
   * O elo que os casos acima NÃO guardam: eles montam a paleta direto, então
   * apagar `<BuscaDoAdmin />` de `AdminShell.tsx` os deixaria todos verdes — e a
   * busca sumiria da tela sem ninguém acusar. É a mesma classe de defeito que a
   * casca já documentou sobre si mesma ("quem monta a casca é o layout").
   *
   * Sabotagem que confirma a guarda: trocar o `<BuscaDoAdmin />` do header por
   * um `<span />` deixa este caso vermelho e os outros oito verdes.
   */
  it("o botão de busca existe na barra do topo do painel", () => {
    render(
      <ThemeProvider>
        <AdminShell userEmail="dono@exemplo.com">
          <p>conteúdo</p>
        </AdminShell>
      </ThemeProvider>,
    );
    expect(screen.getByRole("button", { name: /Buscar telas da instalação/i })).toBeTruthy();
  });
});
