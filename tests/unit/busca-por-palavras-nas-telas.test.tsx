/**
 * AS DUAS TELAS LIGAM A BUSCA POR PALAVRAS AOS CAMPOS NOVOS (#4593).
 *
 * A régua é testada sem DOM em `busca-por-palavras-fluxos-e-funis.test.ts`. O
 * que só a tela prova é a fiação:
 *
 * - Follow-ups entrega à busca o GATILHO de cada fluxo (`trigger_kind`), no
 *   rótulo que a tela de edição mostra — em português e no idioma ativo.
 * - Fluxos de atendimento NÃO entram por gatilho: lá ele não arma nada e é
 *   sempre o padrão («Manual»), então buscaria a lista inteira.
 * - Configurações › Funis entrega as etapas VIVAS de cada funil; a arquivada,
 *   que não recebe card, não acha o funil.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  lista: [] as unknown[],
  mutacao: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  // Um pedaço do espanhol, só o que este arquivo lê.
  es: { "Etapa do funil": "Etapa del embudo", "Lead criado": "Lead creado" } as Record<string, string>,
  idioma: "pt-BR" as "pt-BR" | "es",
}));
vi.mock("@/hooks/i18n/useT", () => ({
  useT: () => (chave: string) => (h.idioma === "es" ? (h.es[chave] ?? chave) : chave),
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
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));
vi.mock("@/app/actions/settings/updatePipelineConfig", () => ({
  updatePipelineConfig: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/app/app/settings/tenant/pipelines/_stages", () => ({
  StagesSection: () => null,
  ancoraDasEtapas: () => "etapas",
}));
vi.mock("@/app/app/settings/tenant/pipelines/_mapping", () => ({
  AgentMappingSection: () => null,
  ancoraDoMapeamento: () => "mapeamento",
}));

// Polyfills que o Radix exige e o jsdom não tem.
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
window.HTMLElement.prototype.setPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

import type { FollowupFlowPointerRow } from "@/hooks/followup/useFollowupFlows";
import { FlowsList } from "@/app/app/ai/followups/_components/FlowsList";
import {
  PipelinesClient,
  type EtapaDoFunil,
  type PipelineRow,
} from "@/app/app/settings/tenant/pipelines/_client";

function fluxo(id: string, name: string, trigger_kind: string): FollowupFlowPointerRow {
  return {
    id,
    name,
    status: "active",
    active_version_id: `v-${id}`,
    handoff_policy: "pause",
    updated_at: "2026-11-01T00:00:00Z",
    trigger_kind,
  } as FollowupFlowPointerRow;
}

const OFICINAS = fluxo("f1", "Kelly · retomada (oficinas mecânicas)", "stage_change");
const POS_VENDA = fluxo("f2", "Retomada pós-venda", "silence");
const BOAS_VINDAS = fluxo("f3", "Boas-vindas", "lead_created");
const FLUXOS = [OFICINAS, POS_VENDA, BOAS_VINDAS];

function montarFluxos(surface?: "atendimento") {
  h.lista = FLUXOS;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <FlowsList initialData={FLUXOS} canWrite={false} {...(surface ? { surface } : {})} />
    </QueryClientProvider>,
  );
  return screen.getByRole("textbox", { name: "Buscar fluxos" });
}

const visiveis = () => FLUXOS.filter((f) => screen.queryByText(f.name)).map((f) => f.id);
const digitar = (campo: HTMLElement, termo: string) => fireEvent.change(campo, { target: { value: termo } });

beforeEach(() => {
  h.idioma = "pt-BR";
  window.history.replaceState(null, "", "/");
});
afterEach(cleanup);

describe("Follow-ups: a tela entrega o gatilho à busca", () => {
  it("U3 — «retomada silencio» deixa só o fluxo de retomada armado por silêncio", () => {
    const campo = montarFluxos();
    digitar(campo, "retomada silencio");
    expect(visiveis()).toEqual(["f2"]);
  });

  it("U2 — «oficina kelly», fora de ordem, acha o fluxo de oficinas", () => {
    const campo = montarFluxos();
    digitar(campo, "oficina kelly");
    expect(visiveis()).toEqual(["f1"]);
  });

  it("U4 — com a tela em espanhol, o rótulo traduzido do gatilho também acha", () => {
    h.idioma = "es";
    const campo = montarFluxos();
    digitar(campo, "embudo");
    expect(visiveis()).toEqual(["f1"]);
    // O rótulo em português segue achando: o nome guardado não muda com o idioma.
    digitar(campo, "etapa do funil");
    expect(visiveis()).toEqual(["f1"]);
  });

  it("a caixa diz que o gatilho também é buscado", () => {
    const campo = montarFluxos();
    expect(campo.getAttribute("placeholder")).toBe("Buscar por nome ou gatilho…");
  });

  it("U9 — fluxos de atendimento seguem buscados só pelo nome", () => {
    const campo = montarFluxos("atendimento");
    digitar(campo, "lead criado");
    expect(visiveis()).toEqual([]);
    expect(campo.getAttribute("placeholder")).toBe("Buscar por nome…");
  });
});

function funil(n: number, name: string, slug: string): PipelineRow {
  return {
    id: `00000000-0000-4000-8000-00000000000${n}`,
    name,
    slug,
    vocabulary: null,
    settings: { fields: [] },
  };
}

function etapa(id: string, name: string, is_archived = false): EtapaDoFunil {
  return { id, name, is_archived, is_won: false, is_lost: false };
}

const PROSPECCAO = funil(1, "Prospecção (Site)", "prospeccao-site");
const POS = funil(2, "Pós-venda", "pos-venda");
const LOCACAO = funil(3, "Locação", "aluguel");
const ETAPAS: Record<string, EtapaDoFunil[]> = {
  [PROSPECCAO.id]: [etapa("e1", "Novo contato"), etapa("e2", "Qualificado")],
  [POS.id]: [etapa("e3", "Aguardando pagamento"), etapa("e4", "Retirada na loja", true)],
};

const cardDe = (p: PipelineRow) => screen.getByTestId(`card-do-funil-${p.id}`);
const funisVisiveis = () => [PROSPECCAO, POS, LOCACAO].filter((p) => !cardDe(p).hidden).map((p) => p.name);

function montarFunis() {
  render(<PipelinesClient pipelines={[PROSPECCAO, POS, LOCACAO]} etapas={ETAPAS} podeEditarConfig />);
  return screen.getByRole("textbox", { name: "Buscar funis" });
}

describe("Configurações › Funis: a tela entrega as etapas à busca", () => {
  it("U1 — «site prospeccao» acha «Prospecção (Site)»", () => {
    const campo = montarFunis();
    digitar(campo, "site prospeccao");
    expect(funisVisiveis()).toEqual(["Prospecção (Site)"]);
  });

  it("U5 — o nome de uma etapa viva acha o funil dela", () => {
    const campo = montarFunis();
    digitar(campo, "aguardando");
    expect(funisVisiveis()).toEqual(["Pós-venda"]);
  });

  it("U5 — a etapa arquivada não acha o funil", () => {
    const campo = montarFunis();
    digitar(campo, "retirada");
    expect(funisVisiveis()).toEqual([]);
  });

  it("a caixa diz que as etapas também são buscadas", () => {
    const campo = montarFunis();
    expect(campo.getAttribute("placeholder")).toBe("Buscar por nome ou etapa…");
  });
});
