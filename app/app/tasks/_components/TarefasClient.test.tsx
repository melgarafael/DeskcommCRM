import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { TarefasClient } from "./TarefasClient";

/**
 * "MINHAS TAREFAS" — o que o lembrete abre (`/app/tasks?assigned_to=me`).
 *
 * O `useTasks` é o de verdade e só o `fetch` é dublê: o que se prova é a URL
 * que sai da tela, porque é ela que decide quais tarefas a rota devolve.
 */

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useTagDeIdioma: () => "pt-BR" }));
vi.mock("@/hooks/auth/AuthProvider", () => ({ useUser: () => ({ id: "u-eu" }) }));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({
  useAssignableMembers: () => ({ isSuccess: true, data: [] }),
}));

const fetchEspiao = vi.fn(
  async (_url: string, _init?: RequestInit) =>
    new Response(JSON.stringify({ data: { tasks: [] } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
);

beforeAll(() => {
  // jsdom não implementa captura de ponteiro — mesmo remédio dos outros testes
  // que abrem um Select do Radix.
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});

beforeEach(() => {
  fetchEspiao.mockClear();
  vi.stubGlobal("fetch", fetchEspiao);
});
afterEach(() => vi.unstubAllGlobals());

function renderTela(minhasDeInicio: boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TarefasClient podeEditar minhasDeInicio={minhasDeInicio} />
    </QueryClientProvider>,
  );
}

const urls = () => fetchEspiao.mock.calls.map(([url]) => String(url));
const corposDosPosts = () =>
  fetchEspiao.mock.calls
    .filter(([, init]) => init?.method === "POST")
    .map(([, init]) => JSON.parse(String(init!.body)) as Record<string, unknown>);

describe("TarefasClient — seletor Responsável", () => {
  it("⭐ aberta pelo lembrete, a busca leva assigned_to=me e o seletor mostra 'Minhas'", async () => {
    renderTela(true);

    await waitFor(() => expect(fetchEspiao).toHaveBeenCalled());
    expect(urls()[0]).toContain("assigned_to=me");
    expect(screen.getByRole("combobox", { name: "Responsável" }).textContent).toContain("Minhas");
  });

  it("escolher 'Todos' faz a próxima busca sair sem o filtro", async () => {
    renderTela(true);
    await waitFor(() => expect(fetchEspiao).toHaveBeenCalled());

    await userEvent.click(screen.getByRole("combobox", { name: "Responsável" }));
    await userEvent.click(await screen.findByRole("option", { name: "Todos" }));

    await waitFor(() => expect(urls().at(-1)).not.toContain("assigned_to"));
    expect(urls().at(-1)).toContain("aberto=true");
  });

  it("aberta pelo menu, mostra todas", async () => {
    renderTela(false);

    await waitFor(() => expect(fetchEspiao).toHaveBeenCalled());
    expect(urls()[0]).not.toContain("assigned_to");
  });
});

describe("TarefasClient — criar a partir de 'Minhas'", () => {
  async function criaSemTocarNoResponsavel() {
    await waitFor(() => expect(fetchEspiao).toHaveBeenCalled());
    await userEvent.click(screen.getByRole("button", { name: "Nova tarefa" }));
    await userEvent.type(screen.getByLabelText("O que precisa ser feito"), "Ligar de volta");
    await userEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(corposDosPosts()).toHaveLength(1));
    return corposDosPosts()[0]!;
  }

  it("⭐ com 'Minhas' ligado, a tarefa nova nasce minha — senão some da lista que a pessoa vê", async () => {
    renderTela(true);
    expect(await criaSemTocarNoResponsavel()).toMatchObject({ assigned_to: "u-eu" });
  });

  it("com 'Todos', a tarefa nova segue nascendo sem responsável", async () => {
    renderTela(false);
    expect(await criaSemTocarNoResponsavel()).toMatchObject({ assigned_to: null });
  });
});

describe("TarefasClient — o calendário não prende o celular", () => {
  it("no modo calendário, a lista continua montada para abaixo de md e o calendário só vale de md para cima", async () => {
    renderTela(false);
    await waitFor(() => expect(fetchEspiao).toHaveBeenCalled());
    await userEvent.click(screen.getByRole("button", { name: "Calendário" }));

    // O jsdom não aplica media query: o que se prova aqui é a REGRA de CSS, a
    // mesma `md` que esconde o seletor. A largura real é do e2e.
    const lista = await screen.findByTestId("tarefas-lista");
    expect(lista.className).toContain("md:hidden");
    const calendario = screen.getByTestId("tarefas-calendario");
    expect(calendario.className).toMatch(/(^|\s)hidden(\s|$)/);
    expect(calendario.className).toContain("md:block");
  });
});

