/**
 * TEXTOS QUE AS TELAS DE SEQUÊNCIA ESCREVIAM CRUS, FORA DE t().
 *
 * Saíam em português em todo idioma: o diálogo de criar fluxo (« Nome », « Cancelar », « Criando… », « Criar fluxo »),
 * o de excluir (« Excluindo… », « Excluir », o nome entre aspas), o cartão da lista (« publicada », « Handoff ») e os
 * modelos prontos (a jornada e a duração: « acompanha por 12 dias ») e a aba « Fila » da página. A cerca do espanhol
 * não os via: ela acusa texto com marca de português (acento, palavra típica), e nenhum destes tem.
 *
 * Em espanhol cada um sai traduzido; em português, byte a byte como antes — com UMA exceção (#3104): no cartão, a
 * política de handoff saía como o valor cru do banco (`pause`), em inglês também na tela em português, e agora sai
 * « Pausar » nos dois idiomas. O valor gravado não muda.
 */
import { readFileSync } from "node:fs";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FollowupFlowPointerRow } from "@/hooks/followup/useFollowupFlows";

const h = vi.hoisted(() => ({
  lista: [] as unknown[],
  mutacao: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
}));
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

import { DeleteFollowupFlowButton } from "@/app/app/ai/followups/_components/DeleteFollowupFlowButton";
import { FlowsList } from "@/app/app/ai/followups/_components/FlowsList";
import { ModelosDialog } from "@/app/app/ai/followups/_components/ModelosDialog";
import { NewFlowDialog } from "@/app/app/ai/followups/_components/NewFlowDialog";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";

afterEach(() => {
  cleanup();
  h.lista = [];
});

const textoDaTela = (el: HTMLElement) => (el.textContent ?? "").replace(/\s+/g, " ");

function noIdioma(idioma: Idioma, filho: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <IdiomaProvider locale={idioma}>{filho}</IdiomaProvider>
    </QueryClientProvider>
  );
}

const FLUXO = {
  id: "11111111-1111-4111-8111-111111111111", name: "Recuperar carrito", status: "active",
  active_version_id: "22222222-2222-4222-8222-222222222222", handoff_policy: "pause", updated_at: "2026-10-19T12:00:00Z",
} as FollowupFlowPointerRow;

describe("criar fluxo", () => {
  it("em espanhol: « Nombre » e « Crear flujo »", () => {
    render(noIdioma("es", <NewFlowDialog open onOpenChange={() => {}} />));
    expect(screen.getByLabelText("Nombre")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Crear flujo" })).toBeTruthy();
  });

  it("em português, como antes", () => {
    render(noIdioma("pt-BR", <NewFlowDialog open onOpenChange={() => {}} />));
    expect(screen.getByLabelText("Nome")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancelar" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Criar fluxo" })).toBeTruthy();
  });
});

describe("excluir fluxo", () => {
  it.each([
    ["es", "¿Eliminar “Recuperar carrito”?", "Eliminar"],
    ["pt-BR", "Excluir “Recuperar carrito”?", "Excluir"],
  ] as const)("em %s: o título com o nome e o botão", async (idioma, titulo, botao) => {
    render(noIdioma(idioma, <DeleteFollowupFlowButton flowId={FLUXO.id} flowName={FLUXO.name} />));
    await userEvent.setup({ delay: null }).click(screen.getByRole("button", { name: botao }));
    const dialogo = screen.getByRole("alertdialog");
    expect(dialogo.textContent).toContain(titulo);
    // Com o diálogo aberto, o gatilho sai da árvore de acessibilidade: o botão achado é o de confirmar.
    expect(within(dialogo).getByRole("button", { name: botao })).toBeTruthy();
  });
});

describe("o cartão da lista", () => {
  it("em espanhol: « Transferencia », « Actualizado el » e a política por extenso — sem `pause` cru", () => {
    h.lista = [FLUXO];
    const { container } = render(noIdioma("es", <FlowsList initialData={[FLUXO]} canWrite />));
    const tela = textoDaTela(container);
    expect(screen.getByText("Transferencia")).toBeTruthy();
    expect(tela).toMatch(/Actualizado el/);
    expect(tela).toContain("Pausar");
    expect(tela).not.toMatch(/\bpause\b/);
    expect(tela).not.toMatch(/Handoff/);
  });

  it("em português: « Atualizado em » e « Pausar », sem o valor cru", () => {
    h.lista = [FLUXO];
    const { container } = render(noIdioma("pt-BR", <FlowsList initialData={[FLUXO]} canWrite />));
    const tela = textoDaTela(container);
    expect(tela).toContain("Handoff");
    expect(tela).toMatch(/Atualizado em/);
    expect(tela).toContain("Pausar");
    expect(tela).not.toMatch(/\bpause\b/);
  });
});

describe("os modelos prontos", () => {
  it("em espanhol: a duração em « días » e a jornada traduzida", () => {
    render(noIdioma("es", <ModelosDialog open onOpenChange={() => {}} nomesExistentes={[]} />));
    const tela = textoDaTela(document.body);
    expect(tela).toMatch(/da seguimiento durante \d+ días/);
    expect(tela).not.toMatch(/\d+ dias(?!\p{L})/u);
    expect(screen.getAllByText("Examen").length).toBeGreaterThan(0);
  });

  it("em português, como antes: « acompanha por 12 dias »", () => {
    render(noIdioma("pt-BR", <ModelosDialog open onOpenChange={() => {}} nomesExistentes={[]} />));
    expect(textoDaTela(document.body)).toMatch(/acompanha por \d+ dias/);
  });
});

describe("a aba « Fila » da página", () => {
  // Limite conhecido: lê a FONTE em vez de renderizar. A página é server component async que consulta o Supabase, e
  // renderizá-la aqui pediria dublê do banco inteiro. O caso fecha o defeito da #3104 (a aba fora de t()), não o
  // layout: o que a tela mostra de fato é conferido na prova pela tela.
  it("passa por t(), e em espanhol vira « Cola »", () => {
    const src = readFileSync("app/app/ai/followups/page.tsx", "utf8");
    expect(src).toMatch(/<TabsTrigger value="fila">\{t\("Fila"\)\}<\/TabsTrigger>/);
    expect(traduzir("Fila", "es")).toBe("Cola");
  });
});
