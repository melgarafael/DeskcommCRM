/**
 * A LISTA DE FOLLOW-UPS GANHA BUSCA E FILTRO POR STATUS (#4593).
 *
 * Quem tem muitos fluxos de retomada, um por nicho, com nomes parecidos que o
 * cartão corta («Kelly · retomada (oficinas mecânica…»), não achava um fluxo
 * sem rolar a lista inteira. A tela ganha a caixa de busca e o filtro de status
 * no mesmo jeito da lista de Agentes; a régua é `filtrarFluxos`
 * (`lib/followup/filtrar-fluxos.ts`), testada à parte sem DOM.
 *
 * Prova de componente, com o termo da issue. Não houve digitação em navegador.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FollowupFlowPointerRow } from "@/hooks/followup/useFollowupFlows";

const h = vi.hoisted(() => ({
  lista: [] as unknown[],
  mutacao: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));
vi.mock("@/hooks/followup/useFollowupFlows", () => ({
  useFollowupFlows: () => ({ data: h.lista }),
  useImportFollowupFlow: h.mutacao,
  useCreateFollowupFlow: h.mutacao,
  useDuplicateFollowupFlow: h.mutacao,
  useExportFollowupFlow: h.mutacao,
}));
vi.mock("@/hooks/followup/useFollowupFlow", () => ({ useDeleteFollowupFlow: h.mutacao, useRenameFollowupFlow: h.mutacao }));
vi.mock("@/hooks/followup/useInstalarModelo", () => ({ useInstalarModelo: h.mutacao }));
vi.mock("@/hooks/followup/useEtapasDeGatilho", () => ({ useEtapasDeGatilho: () => ({ etapas: [], carregando: false }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }) }));

// Polyfills que o Radix Select exige e o jsdom não tem.
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
window.HTMLElement.prototype.setPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();

import { FlowsList } from "./FlowsList";

function fluxo(id: string, name: string, status: FollowupFlowPointerRow["status"]): FollowupFlowPointerRow {
  return {
    id,
    name,
    status,
    active_version_id: status === "active" ? `v-${id}` : null,
    handoff_policy: "pause",
    updated_at: "2026-11-01T00:00:00Z",
  };
}

const LISTA = [
  fluxo("f1", "Kelly · retomada (oficinas mecânicas)", "active"),
  fluxo("f2", "Kelly · retomada (clínicas odontológicas)", "active"),
  fluxo("f3", "Retomada pós-venda", "draft"),
];

function montar(fluxos: FollowupFlowPointerRow[] = LISTA, canWrite = false) {
  h.lista = fluxos;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <FlowsList initialData={fluxos} canWrite={canWrite} />
    </QueryClientProvider>,
  );
  return screen.getByRole("textbox", { name: "Buscar fluxos" });
}

function digitar(campo: HTMLElement, termo: string) {
  fireEvent.change(campo, { target: { value: termo } });
}

afterEach(cleanup);

describe('Follow-ups: "oficina" deixa só o fluxo de oficinas mecânicas', () => {
  it("o termo da issue, sem acento, acha o fluxo e esconde os outros", () => {
    const campo = montar();

    digitar(campo, "oficina");
    expect(screen.getByText("Kelly · retomada (oficinas mecânicas)")).toBeTruthy();
    expect(screen.queryByText("Kelly · retomada (clínicas odontológicas)")).toBeNull();
    expect(screen.queryByText("Retomada pós-venda")).toBeNull();

    digitar(campo, "POS-VENDA");
    expect(screen.getByText("Retomada pós-venda")).toBeTruthy();
    expect(screen.queryByText("Kelly · retomada (oficinas mecânicas)")).toBeNull();
  });

  it("apagar o termo devolve a lista inteira", () => {
    const campo = montar();
    digitar(campo, "oficina");
    digitar(campo, "");
    for (const f of LISTA) expect(screen.getByText(f.name)).toBeTruthy();
  });

  it("termo que não existe mostra o aviso, não a tela de lista vazia", () => {
    const campo = montar();
    digitar(campo, "imobiliaria");
    expect(screen.getByText("Nenhum fluxo corresponde aos filtros atuais.")).toBeTruthy();
    // O convite para criar o primeiro fluxo é de quem não TEM fluxo, não de quem não ACHOU.
    expect(screen.queryByText("Nenhum fluxo de follow-up ainda")).toBeNull();
    // A busca continua à mão para corrigir o termo.
    expect(screen.getByRole("textbox", { name: "Buscar fluxos" })).toBe(campo);
  });

  it("os botões de criar e importar continuam com quem pode escrever", () => {
    const campo = montar(LISTA, true);
    digitar(campo, "imobiliaria");
    expect(screen.getByRole("button", { name: "Novo fluxo" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Importar fluxo" })).toBeTruthy();
  });
});

describe("Follow-ups: filtro por status", () => {
  it("escolher Rascunho deixa só os rascunhos, e a busca procura dentro do recorte", async () => {
    const user = userEvent.setup({ delay: null });
    const campo = montar();

    await user.click(screen.getByRole("combobox", { name: "Filtrar por status" }));
    await user.click(await screen.findByRole("option", { name: "Rascunho" }));

    expect(screen.getByText("Retomada pós-venda")).toBeTruthy();
    expect(screen.queryByText("Kelly · retomada (oficinas mecânicas)")).toBeNull();

    digitar(campo, "oficina");
    expect(screen.getByText("Nenhum fluxo corresponde aos filtros atuais.")).toBeTruthy();
  });
});

describe("Follow-ups: a lista vazia continua como era", () => {
  it("sem nenhum fluxo, não há busca: o cartão convida a criar o primeiro", () => {
    h.lista = [];
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <FlowsList initialData={[]} canWrite={false} />
      </QueryClientProvider>,
    );
    expect(screen.getByText("Nenhum fluxo de follow-up ainda")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Buscar fluxos" })).toBeNull();
  });
});
