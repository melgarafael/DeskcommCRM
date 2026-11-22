/**
 * O PAINEL LATERAL DO MÓDULO CONECTADO (spec 33, F4, tarefa 5).
 *
 * O que fica provado: o painel desenha o MESMO `QuadroDoModulo` da rota (um só caminho de
 * segurança); só o servidor entrega o módulo completo (a ação `moduloParaOPainel`, pelo slug);
 * abre um módulo por vez; `Esc` fecha; um único módulo => o botão abre direto, vários => escolha;
 * sem módulo o botão não existe; em tela estreita abrir leva à rota `/app/m/<slug>`; resposta
 * atrasada de um pedido antigo não reabre o painel.
 *
 * Não provado aqui: o iframe real (o `QuadroDoModulo` é trocado por uma marca), um navegador de
 * verdade (jsdom não faz layout nem aplica o breakpoint de CSS).
 */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { router, auth, moduloParaOPainel, quadro } = vi.hoisted(() => ({
  router: { push: vi.fn() },
  auth: { value: {} as Record<string, unknown> },
  moduloParaOPainel: vi.fn(),
  quadro: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/hooks/auth/AuthProvider", () => ({ useAuth: () => auth.value }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/app/actions/modulo/moduloParaOPainel", () => ({ moduloParaOPainel }));
vi.mock("@/components/modulo/QuadroDoModulo", () => ({
  QuadroDoModulo: (props: { modulo: { slug: string } }) => {
    quadro(props);
    return <div data-testid="quadro">{props.modulo.slug}</div>;
  },
}));

import { BotaoDoPainelDoModulo, PainelDoModuloProvider } from "./PainelDoModulo";

const A = {
  slug: "acme-comanda",
  titulo: "Comanda",
  icone: "ListChecks",
  serviceOrigin: "https://comanda.exemplo.test",
  installationId: "00000000-0000-4000-8000-000000000003",
};
const B = {
  slug: "acme-fidelidade",
  titulo: "Fidelidade",
  icone: "Star",
  serviceOrigin: "https://fidelidade.exemplo.test",
  installationId: "00000000-0000-4000-8000-000000000004",
};

function definirModulos(modulos: { slug: string; titulo: string }[] | undefined) {
  auth.value = {
    user: { is_platform_admin: false, support: null },
    activeOrg: { orgId: "org-1", role: "viewer", modulos_conectados: modulos },
  };
}

function largura(larga: boolean) {
  vi.stubGlobal("matchMedia", (consulta: string) => ({
    matches: larga,
    media: consulta,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

function montar() {
  return render(
    <PainelDoModuloProvider>
      <BotaoDoPainelDoModulo />
    </PainelDoModuloProvider>,
  );
}

beforeEach(() => {
  router.push.mockReset();
  quadro.mockReset();
  moduloParaOPainel.mockReset();
  moduloParaOPainel.mockImplementation(async (slug: string) =>
    slug === A.slug ? A : slug === B.slug ? B : null,
  );
  largura(true);
  definirModulos([{ slug: A.slug, titulo: A.titulo }]);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("o botão do topo", () => {
  it("sem módulo o botão não existe", () => {
    definirModulos([]);
    montar();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("sem lista alguma (organização antiga) o botão também não existe", () => {
    definirModulos(undefined);
    montar();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("com um único módulo, o botão abre o painel direto, sem escolha", async () => {
    montar();
    await userEvent.click(screen.getByRole("button", { name: /Abrir ao lado/ }));
    await waitFor(() => expect(screen.getByTestId("quadro").textContent).toBe(A.slug));
    expect(moduloParaOPainel).toHaveBeenCalledWith(A.slug);
    expect(screen.queryByRole("menuitem")).toBeNull();
  });

  it("com vários módulos, o botão mostra a escolha e só então abre", async () => {
    definirModulos([
      { slug: A.slug, titulo: A.titulo },
      { slug: B.slug, titulo: B.titulo },
    ]);
    montar();
    await userEvent.click(screen.getByRole("button", { name: "Abrir ao lado" }));
    expect(moduloParaOPainel).not.toHaveBeenCalled();
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
      "Comanda",
      "Fidelidade",
    ]);
    await userEvent.click(screen.getByRole("menuitem", { name: "Fidelidade" }));
    await waitFor(() => expect(screen.getByTestId("quadro").textContent).toBe(B.slug));
  });
});

describe("o painel", () => {
  it("usa o MESMO QuadroDoModulo, com o módulo que veio do servidor", async () => {
    montar();
    await userEvent.click(screen.getByRole("button", { name: /Abrir ao lado/ }));
    await waitFor(() => expect(quadro).toHaveBeenCalled());
    expect(quadro).toHaveBeenLastCalledWith({ modulo: A });
    expect(screen.getAllByTestId("quadro")).toHaveLength(1);
  });

  it("abre um módulo por vez: abrir o segundo troca o primeiro", async () => {
    definirModulos([
      { slug: A.slug, titulo: A.titulo },
      { slug: B.slug, titulo: B.titulo },
    ]);
    montar();
    for (const nome of ["Comanda", "Fidelidade"]) {
      await userEvent.click(screen.getByRole("button", { name: "Abrir ao lado" }));
      await userEvent.click(screen.getByRole("menuitem", { name: nome }));
    }
    await waitFor(() => expect(screen.getByTestId("quadro").textContent).toBe(B.slug));
    expect(screen.getAllByTestId("quadro")).toHaveLength(1);
    expect(screen.getAllByTestId("painel-do-modulo")).toHaveLength(1);
  });

  it("Esc fecha", async () => {
    montar();
    await userEvent.click(screen.getByRole("button", { name: /Abrir ao lado/ }));
    await screen.findByTestId("quadro");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByTestId("painel-do-modulo")).toBeNull();
    expect(screen.queryByTestId("quadro")).toBeNull();
  });

  it("clicar de novo no botão do módulo aberto fecha", async () => {
    montar();
    const botao = screen.getByRole("button", { name: /Abrir ao lado/ });
    await userEvent.click(botao);
    await screen.findByTestId("quadro");
    await userEvent.click(botao);
    expect(screen.queryByTestId("painel-do-modulo")).toBeNull();
  });

  it("módulo que o servidor recusa (null) mostra aviso e nenhum quadro", async () => {
    moduloParaOPainel.mockResolvedValue(null);
    montar();
    await userEvent.click(screen.getByRole("button", { name: /Abrir ao lado/ }));
    expect(await screen.findByText("Não foi possível abrir este módulo.")).toBeTruthy();
    expect(screen.queryByTestId("quadro")).toBeNull();
  });

  it("resposta atrasada de um pedido fechado não reabre o painel", async () => {
    let entregar: (m: typeof A) => void = () => {};
    moduloParaOPainel.mockReturnValue(new Promise((r) => (entregar = r)));
    montar();
    await userEvent.click(screen.getByRole("button", { name: /Abrir ao lado/ }));
    await userEvent.keyboard("{Escape}");
    await act(async () => entregar(A));
    expect(screen.queryByTestId("painel-do-modulo")).toBeNull();
  });

  it("o navegador nunca recebe o endereço do serviço antes de abrir", () => {
    montar();
    expect(quadro).not.toHaveBeenCalled();
    expect(document.body.innerHTML).not.toContain(A.serviceOrigin);
  });
});

describe("tela estreita", () => {
  it("abrir leva à rota do módulo, sem painel e sem pedir nada ao servidor", async () => {
    largura(false);
    montar();
    await userEvent.click(screen.getByRole("button", { name: /Abrir ao lado/ }));
    expect(router.push).toHaveBeenCalledWith(`/app/m/${A.slug}`);
    expect(moduloParaOPainel).not.toHaveBeenCalled();
    expect(screen.queryByTestId("painel-do-modulo")).toBeNull();
  });
});
