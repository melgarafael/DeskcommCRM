import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { PipelinePageClient } from "./_client";
import type { Pipeline, Stage } from "@/lib/kanban/types";

/**
 * A página da lista do funil (#3172), espionada — e não mockada em silêncio.
 *
 * `vi.hoisted` porque a fábrica do `vi.mock` é içada acima dos imports: uma
 * `const` comum ainda não existiria quando a fábrica roda.
 */
const { useLeadsPaginados } = vi.hoisted(() => ({ useLeadsPaginados: vi.fn() }));

// Polyfills que o Radix Select exige e o jsdom não tem (mesmo padrão de
// components/kanban/MoveToOtherPipelineDialog.test.tsx).
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
window.HTMLElement.prototype.setPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

/**
 * Troca rápida de funil no cabeçalho do quadro.
 *
 * O `h1` com o nome do funil vira o gatilho de um `Select` quando há mais de
 * um funil vivo: pular de funil sem voltar à lista. Com um funil só, `h1`
 * puro — seletor de uma opção é ruído permanente.
 */

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push }),
  usePathname: () => "/app/pipelines/p-1",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/hooks/kanban/useBoard", () => ({
  useBoard: () => ({
    data: {
      pipeline: { id: "p-1", name: "Vendas", vocabulary: null, settings: null },
      stages: [],
      leads: [],
    },
    isLoading: false,
    error: null,
    pulses: new Map(),
    realtimeStatus: "SUBSCRIBED",
    seguranca: { divergencias: 0, ultimaVerificacao: null },
  }),
}));
vi.mock("@/hooks/kanban/useBulkAction", () => ({
  useBulkAction: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useUser: () => ({ id: "u-1" }),
  useActiveOrg: () => ({ orgId: "org-1", role: "agent" }),
  usePermission: () => false,
}));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({
  useAssignableMembers: () => ({ data: [] }),
}));
vi.mock("@/hooks/kanban/useAssignableAgents", () => ({
  useAssignableAgents: () => ({ data: [] }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/components/kanban/FilterBar", () => ({ FilterBar: () => null }));
vi.mock("@/components/kanban/NewLeadDialog", () => ({ NewLeadDialog: () => null }));
vi.mock("@/components/kanban/KanbanBoard", () => ({ KanbanBoard: () => null }));
// A ficha do negócio é a MESMA do quadro (dossiê, tarefas, propostas): abrir o
// dossiê inteiro aqui mediria a ficha, não a aba.
vi.mock("@/components/kanban/LeadDossier", () => ({ LeadDossier: () => null }));
vi.mock("@/hooks/kanban/useLeadsPaginados", () => ({
  LEADS_POR_PAGINA: 50,
  useLeadsPaginados: (...args: unknown[]) => useLeadsPaginados(...args),
}));
vi.mock("@/components/kanban/BulkActionBar", () => ({ BulkActionBar: () => null }));

const FUNIS = [
  { id: "p-1", name: "Vendas" },
  { id: "p-2", name: "Suporte" },
  { id: "p-3", name: "Parcerias" },
];

/**
 * A LEITURA LEVE que o server component entrega (#3172, item 4 do CR): o funil
 * e as etapas, sem negócio nenhum. É dela que a aba Lista vive quando o quadro
 * não foi lido — por isso estes casos a passam à mão, como a página real faz.
 */
const FUNIL_LEVE = {
  id: "p-1",
  name: "Vendas",
  vocabulary: null,
  settings: {},
} as unknown as Pipeline;
const ETAPAS = [
  { id: "e-1", name: "Prospecção", position: 0, is_won: false, is_lost: false },
] as unknown as Stage[];

/** Os negócios da página que a rota devolveria — dois, com `has_more`. */
const PAGINA = {
  leads: [
    {
      id: "l-1",
      title: "Negócio A",
      stage_id: "e-1",
      value_cents: 125_000,
      currency: "BRL",
      last_activity_at: "2026-10-01T12:00:00.000Z",
    },
    {
      id: "l-2",
      title: "Negócio B",
      stage_id: "e-1",
      value_cents: null,
      currency: null,
      last_activity_at: null,
    },
  ],
  // Sem `total` (a rota não conta mais; ver o cabeçalho de `ListaDoFunil`):
  // o que a tela sabe é o `perPage` que pediu e o `hasMore` que voltou.
  page: 1,
  perPage: 2,
  hasMore: true,
};

beforeEach(() => {
  push.mockClear();
  useLeadsPaginados.mockReset();
  useLeadsPaginados.mockReturnValue({ data: PAGINA, isLoading: false, error: null });
});

describe("troca rápida de funil", () => {
  it("com um funil só, mostra o h1 e nenhum seletor", () => {
    render(
      <PipelinePageClient
        pipelineId="p-1"
        initialName="Vendas"
        role="admin"
        funis={[{ id: "p-1", name: "Vendas" }]}
        funilInicial={FUNIL_LEVE}
        etapasIniciais={ETAPAS}
      />,
    );

    expect(screen.getByRole("heading", { name: "Vendas" })).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("com vários funis, o título vira seletor com os funis vivos", async () => {
    render(
      <PipelinePageClient
        pipelineId="p-1"
        initialName="Vendas"
        role="admin"
        funis={FUNIS}
        funilInicial={FUNIL_LEVE}
        etapasIniciais={ETAPAS}
      />,
    );

    // O h1 continua existindo para leitor de tela, escondido do olho.
    expect(screen.getByRole("heading", { name: "Vendas" })).toBeTruthy();

    const seletor = screen.getByRole("combobox", { name: "Trocar de funil: Vendas" });
    await userEvent.click(seletor);

    expect(await screen.findByRole("option", { name: "Vendas" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Suporte" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Parcerias" })).toBeTruthy();
  });

  it("escolher outro funil navega para o quadro dele, sem query string", async () => {
    render(
      <PipelinePageClient
        pipelineId="p-1"
        initialName="Vendas"
        role="admin"
        funis={FUNIS}
        funilInicial={FUNIL_LEVE}
        etapasIniciais={ETAPAS}
      />,
    );

    await userEvent.click(screen.getByRole("combobox", { name: "Trocar de funil: Vendas" }));
    await userEvent.click(await screen.findByRole("option", { name: "Suporte" }));

    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith("/app/pipelines/p-2");
  });

  it("escolher o funil atual não navega", async () => {
    render(
      <PipelinePageClient
        pipelineId="p-1"
        initialName="Vendas"
        role="admin"
        funis={FUNIS}
        funilInicial={FUNIL_LEVE}
        etapasIniciais={ETAPAS}
      />,
    );

    await userEvent.click(screen.getByRole("combobox", { name: "Trocar de funil: Vendas" }));
    await userEvent.click(await screen.findByRole("option", { name: "Vendas" }));

    expect(push).not.toHaveBeenCalled();
  });
});

/**
 * A TERCEIRA ABA DO FUNIL (#3172) — a Lista.
 *
 * O que este bloco mede é a LIGAÇÃO: o interruptor do cabeçalho passa a
 * comportar três visões, e a terceira monta `ListaDoFunil` — a lista paginada
 * NO BANCO, que é o defeito que a issue descreve ("a rota do quadro lê o funil
 * inteiro de uma vez, sem paginação").
 *
 * A lista é montada DE VERDADE (só o hook de dados é dublado): um
 * `vi.mock("@/components/kanban/ListaDoFunil")` provaria que o interruptor
 * escolheu um nome, não que existe uma lista atrás dele.
 */
describe("a terceira aba do funil (Lista)", () => {
  const montar = (visoes = FUNIS) =>
    render(
      <PipelinePageClient
        pipelineId="p-1"
        initialName="Vendas"
        role="admin"
        funis={visoes}
        funilInicial={FUNIL_LEVE}
        etapasIniciais={ETAPAS}
      />,
    );

  it("as três visões convivem no interruptor, e o Quadro continua sendo o padrão", () => {
    montar();

    expect(screen.getByTestId("visao-quadro").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("visao-calendario").getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByTestId("visao-lista").getAttribute("aria-pressed")).toBe("false");
    // O quadro é o padrão: a aba nova não sequestra a tela de quem só move card.
    expect(screen.queryByTestId("lista-do-funil")).toBeNull();
  });

  it("⭐ clicar em Lista monta a lista, com os negócios DA PÁGINA que a rota devolveu", async () => {
    montar();

    await userEvent.click(screen.getByTestId("visao-lista"));

    expect(screen.getByTestId("visao-lista").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("lista-do-funil")).toBeTruthy();
    // A página 1 é o que a lista pede ao montar; sem `?page=` a lista não é
    // paginada — é o quadro com outra cara.
    expect(useLeadsPaginados).toHaveBeenLastCalledWith("p-1", 1);
    expect(screen.getByText("Negócio A")).toBeTruthy();
    expect(screen.getByText("Negócio B")).toBeTruthy();
  });

  it("`Próxima` avança a página — o pedido ao banco muda, não o filtro da lista", async () => {
    montar();

    await userEvent.click(screen.getByTestId("visao-lista"));
    await userEvent.click(screen.getByRole("button", { name: "Próxima" }));

    expect(useLeadsPaginados).toHaveBeenLastCalledWith("p-1", 2);
  });

  it("⭐ a tela diz a página ATUAL, e não promete um total exato", async () => {
    montar();

    await userEvent.click(screen.getByTestId("visao-lista"));

    // "página 1", e só: o "de {total}" saiu porque a rota parou de contar (a
    // contagem exata varria o funil inteiro — ver o cabeçalho da rota). O que
    // não pode voltar é a promessa de um total que ninguém mediu.
    expect(screen.getByText("página 1")).toBeTruthy();
    expect(screen.queryByText(/de \d/)).toBeNull();
  });

  it("sem `has_more` não há botão de Próxima — a última página não promete outra", async () => {
    useLeadsPaginados.mockReturnValue({
      data: { ...PAGINA, hasMore: false, page: 1 },
      isLoading: false,
      error: null,
    });
    montar();

    await userEvent.click(screen.getByTestId("visao-lista"));

    expect(screen.queryByRole("button", { name: "Próxima" })).toBeNull();
  });

  it("voltar para o Quadro desmonta a lista (a visão é um olhar, não uma pilha)", async () => {
    montar();

    await userEvent.click(screen.getByTestId("visao-lista"));
    expect(screen.getByTestId("lista-do-funil")).toBeTruthy();

    await userEvent.click(screen.getByTestId("visao-quadro"));
    expect(screen.queryByTestId("lista-do-funil")).toBeNull();
  });
});
