/**
 * A BUSCA DE FUNIS SEGUE AS ETAPAS QUE O EDITOR DA MESMA TELA SALVOU (#4593).
 *
 * As etapas da página chegam do servidor uma vez; o editor de etapas
 * (`StagesSection`) relê a dele (`agent-mapping`) depois de criar, renomear ou
 * arquivar. Se a busca ficasse com a lista do servidor, o funil seria achado
 * pelo nome velho e não pelo novo, e a etapa arquivada seguiria achando o funil
 * — até alguém recarregar a página.
 *
 * Aqui a releitura do editor é simulada como ela acontece: a resposta da rota
 * muda e o cache da etapa é invalidado (o `reler` de `useStages`).
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ etapas: {} as Record<string, { id: string; name: string }[]> }));

vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: vi.fn(async (url: string) => {
      const m = /\/api\/v1\/pipelines\/([^/]+)\/agent-mapping/.exec(url);
      if (m) {
        const etapas = (h.etapas[decodeURIComponent(m[1]!)] ?? []).map((e) => ({
          ...e,
          is_won: false,
          is_lost: false,
        }));
        return {
          data: {
            etapas,
            mapeamento: {
              new: null,
              contacted: null,
              qualifying: null,
              qualified: null,
              negotiating: null,
              won: null,
              lost: null,
            },
          },
        };
      }
      return { data: { taxas: [] } };
    }),
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));
vi.mock("@/app/actions/settings/updatePipelineConfig", () => ({
  updatePipelineConfig: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/app/app/settings/tenant/pipelines/_mapping", () => ({
  AgentMappingSection: () => null,
  ancoraDoMapeamento: () => "mapeamento",
}));

window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
window.HTMLElement.prototype.setPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

import {
  PipelinesClient,
  type EtapaDoFunil,
  type PipelineRow,
} from "@/app/app/settings/tenant/pipelines/_client";

function funil(n: number, name: string, slug: string): PipelineRow {
  return {
    id: `00000000-0000-4000-8000-00000000000${n}`,
    name,
    slug,
    vocabulary: null,
    settings: { fields: [] },
  };
}

const PROSPECCAO = funil(1, "Prospecção (Site)", "prospeccao-site");
const POS = funil(2, "Pós-venda", "pos-venda");
const FUNIS = [PROSPECCAO, POS];

const doServidor = (): Record<string, EtapaDoFunil[]> => ({
  [PROSPECCAO.id]: [{ id: "e1", name: "Novo contato", is_archived: false }],
  [POS.id]: [{ id: "e3", name: "Aguardando pagamento", is_archived: false }],
});

let qc: QueryClient;

function montar() {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <PipelinesClient pipelines={FUNIS} etapas={doServidor()} podeEditarConfig />
    </QueryClientProvider>,
  );
  return screen.getByRole("textbox", { name: "Buscar funis" });
}

const visiveis = () =>
  FUNIS.filter((p) => !screen.getByTestId(`card-do-funil-${p.id}`).hidden).map((p) => p.name);

/** O que o editor faz depois de salvar: a rota passa a devolver o novo, e o cache é relido. */
async function editorSalvou(pipelineId: string, etapas: { id: string; name: string }[]) {
  // Salvar só existe depois de o editor ter lido as etapas uma vez.
  await waitFor(() => expect(qc.getQueryState(["agent-mapping", pipelineId])?.status).toBe("success"));
  h.etapas[pipelineId] = etapas;
  await act(async () => {
    await qc.invalidateQueries({ queryKey: ["agent-mapping", pipelineId] });
  });
}

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  h.etapas = {
    [PROSPECCAO.id]: [{ id: "e1", name: "Novo contato" }],
    [POS.id]: [{ id: "e3", name: "Aguardando pagamento" }],
  };
});
afterEach(cleanup);

describe("Funis: a busca acompanha o editor de etapas da mesma tela", () => {
  it("etapa renomeada: acha pelo nome novo e não pelo velho", async () => {
    const campo = montar();
    await editorSalvou(POS.id, [{ id: "e3", name: "Pendência bancária" }]);

    fireEvent.change(campo, { target: { value: "pendencia" } });
    await waitFor(() => expect(visiveis()).toEqual(["Pós-venda"]));
    fireEvent.change(campo, { target: { value: "aguardando" } });
    await waitFor(() => expect(visiveis()).toEqual([]));
  });

  it("etapa nova: acha o funil por ela", async () => {
    const campo = montar();
    await editorSalvou(PROSPECCAO.id, [
      { id: "e1", name: "Novo contato" },
      { id: "e9", name: "Retorno agendado" },
    ]);

    fireEvent.change(campo, { target: { value: "retorno agendado" } });
    await waitFor(() => expect(visiveis()).toEqual(["Prospecção (Site)"]));
  });

  it("etapa arquivada (some da leitura do editor): deixa de achar o funil", async () => {
    const campo = montar();
    fireEvent.change(campo, { target: { value: "aguardando" } });
    await waitFor(() => expect(visiveis()).toEqual(["Pós-venda"]));

    await editorSalvou(POS.id, []);
    await waitFor(() => expect(visiveis()).toEqual([]));
  });
});

describe("Funis: leitura velha do editor, guardada de antes de a página abrir, não vence a do servidor", () => {
  it("etapa renomeada em outra tela (o Kanban): vale o nome que a página trouxe", async () => {
    // O cache do editor ainda guarda o nome de antes (o Kanban renomeou e não
    // mexeu nele) e está fresco: o editor não relê ao montar.
    qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
    // No MESMO milissegundo em que a página abre: o caso de fronteira.
    const agora = Date.now();
    qc.setQueryData(
      ["agent-mapping", POS.id],
      {
        etapas: [{ id: "e3", name: "Aguardando pagamento", is_won: false, is_lost: false }],
        mapeamento: { new: null, contacted: null, qualifying: null, qualified: null, negotiating: null, won: null, lost: null },
      },
      { updatedAt: agora },
    );
    const servidor = doServidor();
    servidor[POS.id] = [{ id: "e3", name: "Pendência bancária", is_archived: false }];
    const relogio = vi.spyOn(Date, "now").mockReturnValue(agora);
    render(
      <QueryClientProvider client={qc}>
        <PipelinesClient pipelines={FUNIS} etapas={servidor} podeEditarConfig />
      </QueryClientProvider>,
    );
    relogio.mockRestore();
    const campo = screen.getByRole("textbox", { name: "Buscar funis" });

    fireEvent.change(campo, { target: { value: "pendencia" } });
    await waitFor(() => expect(visiveis()).toEqual(["Pós-venda"]));
    fireEvent.change(campo, { target: { value: "aguardando" } });
    await waitFor(() => expect(visiveis()).toEqual([]));
  });
});
