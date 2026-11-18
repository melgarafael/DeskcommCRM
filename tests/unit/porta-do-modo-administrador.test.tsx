/**
 * A PORTA DO MODO ADMINISTRADOR NAVEGA POR CONTA PRÓPRIA.
 *
 * O e2e (`tests/e2e/painel-de-configuracao-da-instalacao.spec.ts:86`) mede a
 * jornada inteira; este teste prende a invariante que o CI do #3608 mostrou
 * quebrada (run 40791878045, job 123178915982). No trace daquele vermelho, o
 * clique na porta FECHOU o menu (`data-state="closed"`) e **nenhuma** requisição
 * de navegação saiu — nem documento, nem `_rsc` —, e a URL ficou em
 * `/app/inbox`. O item foi selecionado; a navegação do `<Link>`, não.
 *
 * A razão está na ordem dos handlers: o Next chama o `onClick` que recebe por
 * prop ANTES do `linkClicked` dele (`next/link` 16.4.2, `app-dir/link.js`), e
 * esse `onClick` é o do Radix, que termina fechando o menu e desmontando a porta
 * no meio do MESMO evento. O `<Link>` é, portanto, um caminho que pode se
 * perder; a porta não pode depender só dele.
 *
 * O que se mede aqui é exatamente isso: `router.push("/admin")` sai do handler
 * da porta, uma vez só. Em jsdom o `<Link>` não tem router de App Router e não
 * navega sozinho — se o `push` aparecer, foi a porta que o fez.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.hoisted(() => vi.fn());
const signOut = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useUser: () => ({
    full_name: "E2E Dono do Servidor",
    email: "e2e-dono@deskcomm.test",
    avatar_url: null,
    is_platform_admin: true,
  }),
  useAuth: () => ({ signOut }),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/components/theme/theme-toggle", () => ({ ThemeToggle: () => null }));
vi.mock("@/components/shell/SeletorDeIdioma", () => ({ SeletorDeIdioma: () => null }));

import { UserMenu } from "@/components/shell/UserMenu";

async function abrirOMenu() {
  const user = userEvent.setup();
  render(<UserMenu />);
  await user.click(screen.getByRole("button", { name: /menu do usuário/i }));
  return { user, porta: await screen.findByTestId("porta-modo-administrador") };
}

describe("porta do modo administrador", () => {
  beforeEach(() => {
    push.mockClear();
  });

  it("o clique leva ao painel por caminho próprio, sem depender do <Link>", async () => {
    const { user, porta } = await abrirOMenu();

    await user.click(porta);

    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith("/admin");
  });

  it("clique modificado não empurra a aba atual — quem abre aba nova é o href", async () => {
    const { porta } = await abrirOMenu();

    // ⌘/Ctrl+clique: o navegador cumpre o href numa aba nova. Empurrar a aba
    // atual aqui faria a pessoa perder a tela em que estava.
    fireEvent.click(porta, { ctrlKey: true });

    expect(push).not.toHaveBeenCalled();
  });
});
