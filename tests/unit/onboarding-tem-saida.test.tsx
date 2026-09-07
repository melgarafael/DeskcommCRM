/**
 * O WIZARD TEM PORTA DE SAÍDA — para quem tem outra organização, e só.
 *
 * ─── O defeito que esta cerca fecha ──────────────────────────────────────
 *
 * `app/app/layout.tsx` manda para `/onboarding` toda organização ativa sem
 * `onboarded_at`, e o layout de `/app` sai da árvore junto com o
 * `TenantSwitcher`. Quem trocou de organização pelo seletor do topo caía num
 * wizard de seis passos com três controles na tela — "Termos de Uso",
 * "Política de Privacidade" e um "Continuar" desabilitado — e nenhuma saída.
 * Medido no snapshot de uma falha do CI, não deduzido.
 *
 * ─── O que este arquivo prova, e o que fica para a spec em tela ──────────
 *
 * Aqui: as três formas do controle (nenhuma outra organização, uma, várias) e o
 * fato de que ele NAVEGA depois de trocar. A navegação é o detalhe que mais
 * facilmente se perde numa refatoração e falha em silêncio: `setActiveOrg`
 * muda o cookie, então sem a navegação completa a
 * pessoa continua olhando o wizard da organização que acabou de deixar — a tela
 * fica idêntica, e o clique parece não ter feito nada.
 *
 * A jornada inteira (trocar, cair no wizard, voltar) é da
 * `tests/e2e/troca-de-organizacao-tem-volta.spec.ts`, que dirige o browser.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, describe, expect, it, vi, beforeEach } from "vitest";

const setActiveOrg = vi.fn(async () => ({ ok: true }));
const replace = vi.fn();

vi.mock("@/app/actions/shell/setActiveOrg", () => ({
  setActiveOrg: (...args: unknown[]) => setActiveOrg(...(args as [])),
}));
vi.mock("@/components/shell/OrganizationTransitionProvider", () => ({
  useOrganizationTransition: () => ({ begin: vi.fn(), cancel: vi.fn() }),
}));
const realWindow = window;
vi.stubGlobal("window", new Proxy(realWindow, {
  get(target, property) {
    if (property === "location") return { ...target.location, assign: replace };
    return Reflect.get(target, property, target);
  },
}));

import { OutrasOrganizacoes } from "@/app/onboarding/_components/OutrasOrganizacoes";

afterEach(cleanup);
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
  setActiveOrg.mockClear();
  replace.mockClear();
});

describe("a saída do wizard", () => {
  it("não existe para quem só tem esta organização", () => {
    // Quem instalou o sistema e está configurando a própria empresa não tem
    // para onde voltar — oferecer o controle prometeria uma ação vazia, que é
    // o anti-pattern de controle decorativo desta base.
    render(<OutrasOrganizacoes outras={[]} />);
    expect(screen.queryByTestId("sair-do-onboarding")).toBeNull();
  });

  it("com uma organização, o rótulo diz PARA ONDE se vai", () => {
    // "Trocar de organização" faria a pessoa abrir um menu para descobrir a
    // única resposta. Quem está preso aqui quer o nome do lugar de onde veio.
    render(<OutrasOrganizacoes outras={[{ id: "o1", nome: "Clínica Vida" }]} />);
    expect(screen.getByTestId("sair-do-onboarding")).toHaveTextContent("Voltar para Clínica Vida");
  });

  it("clicar troca a organização E NAVEGA — as duas coisas", async () => {
    // ⚠️ A navegação é metade do conserto. `setActiveOrg` muda o cookie; sem a navegação completa o wizard continua na tela,
    // idêntico. O clique pareceria não ter feito nada.
    render(<OutrasOrganizacoes outras={[{ id: "o1", nome: "Clínica Vida" }]} />);
    fireEvent.click(screen.getByTestId("sair-do-onboarding"));

    await waitFor(() => expect(setActiveOrg).toHaveBeenCalledWith("o1"));
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/app/inbox"));
  });

  it("com várias, vira menu — e cada organização é um destino", async () => {
    // ⚠️ `userEvent` e não `fireEvent.click`: o menu do Radix abre no PONTEIRO,
    // não no clique sintético. Com `fireEvent` o gatilho fica `data-state=
    // "closed"` e o caso reprovaria por causa da ferramenta, acusando o produto.
    const user = userEvent.setup();
    render(
      <OutrasOrganizacoes
        outras={[
          { id: "o1", nome: "Clínica Vida" },
          { id: "o2", nome: "Studio Norte" },
        ]}
      />,
    );
    const gatilho = screen.getByTestId("sair-do-onboarding");
    expect(gatilho).toHaveTextContent("Ir para outra organização");
    await user.click(gatilho);
    // O menu do Radix monta ao abrir; os dois destinos têm testid próprio para a
    // spec em tela poder escolher um deles sem depender da ordem.
    expect(await screen.findByTestId("sair-do-onboarding-item-o1")).toBeInTheDocument();
    expect(screen.getByTestId("sair-do-onboarding-item-o2")).toBeInTheDocument();
  });
});
