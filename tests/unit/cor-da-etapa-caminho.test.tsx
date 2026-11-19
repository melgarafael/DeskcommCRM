/**
 * A COR DA ETAPA, PELO CAMINHO INTEIRO (#4802, item 2 de 5).
 *
 * A pergunta desta fatia não é "existe um seletor?" — é "o que a tela grava é o
 * que o quadro pinta?". Ler o código responde isso no dia em que foi escrito; o
 * primeiro ajuste de nome de campo quebra em silêncio, e o sintoma é o pior
 * tipo: a tela mostra verde, o quadro continua neutro, e ninguém sabe em qual
 * acreditar. Por isso os três trechos são medidos na MESMA corrente:
 *
 *   1. a TELA manda `color:<tom>` no PATCH da etapa (o caminho de escrita que já
 *      existia — o mesmo do import/export, não um segundo);
 *   2. a OPERAÇÃO grava a coluna `crm_stages.color`, com a autoria dos outros
 *      campos;
 *   3. o QUADRO pinta o ponto com aquele tom (`StageColumn`), e a resposta do
 *      PATCH devolve o mesmo valor para a tela.
 *
 * Sabotagens que este arquivo derruba, uma por trecho:
 *   (i) gravar em `stage_color`/`cor` em vez de `color` — (2) e (3) reprovam;
 *  (ii) remover o «Padrão» — o teste de restauração reprova.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EstadoDoMapeamento, EtapaDoFunil } from "@/hooks/pipelines/useAgentMapping";
import type { Stage } from "@/lib/kanban/types";

vi.mock("@/lib/api/client", () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
// O quadro precisa de um Droppable; o dublê desenha o conteúdo e nada mais.
vi.mock("@hello-pangea/dnd", async () => {
  const React = await import("react");
  return {
    DragDropContext: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    Droppable: ({ children }: { children: (p: object, s: object) => ReactNode }) => (
      <>
        {children(
          { innerRef: () => {}, droppableProps: {}, placeholder: null },
          { isDraggingOver: false },
        )}
      </>
    ),
    Draggable: ({ children }: { children: (p: object, s: object) => ReactNode }) => (
      <>
        {children(
          { innerRef: () => {}, draggableProps: {}, dragHandleProps: {} },
          { isDragging: false, isDropAnimating: false },
        )}
      </>
    ),
  };
});
// A lista de cards não é o objeto desta fatia: o ponto da etapa é do cabeçalho.
vi.mock("@/components/kanban/CardsDaColuna", () => ({ CardsDaColuna: () => null }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));

import { apiClient } from "@/lib/api/client";
import { corpo, atualizarEtapa } from "@/lib/leads/stage-operations";
import { StageColumn } from "@/components/kanban/StageColumn";
import { StagesSection } from "@/app/app/settings/tenant/pipelines/_stages";

// Polyfills que o Radix (Select e Popover) exige e o jsdom não tem.
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
window.HTMLElement.prototype.setPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const PIPE = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";
const ETAPA = "e1";

/** A etapa com a cor que já estava gravada — o que a tela tem de mostrar. */
const ETAPAS: EtapaDoFunil[] = [
  { id: ETAPA, name: "Carrinho abandonado", is_won: false, is_lost: false, color: "#0091ff" },
  { id: "e2", name: "Aguardando pagamento", is_won: false, is_lost: false, color: null },
];

const VAZIO = {
  new: null,
  contacted: null,
  qualifying: null,
  qualified: null,
  negotiating: null,
  won: null,
  lost: null,
};

function estado(): EstadoDoMapeamento {
  return { etapas: ETAPAS, mapeamento: VAZIO };
}

function montarTela() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <StagesSection pipelineId={PIPE} ancoraMapeamento={`mapeamento-${PIPE}`} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(apiClient.get).mockResolvedValue({ data: estado() } as never);
  vi.mocked(apiClient.patch).mockResolvedValue({ data: {} } as never);
});

describe("① a tela de etapas: mostra a cor de hoje e grava pela rota da etapa", () => {
  it("abre mostrando a COR ATUAL da etapa, pelo nome do tom", async () => {
    montarTela();
    await waitFor(() => expect(screen.getByTestId(`cor-${ETAPA}`)).toBeTruthy());
    expect(screen.getByTestId(`cor-nome-${ETAPA}`).textContent).toBe("Azul");
    // Etapa sem cor é «Padrão» — o valor de hoje (`NULL`), não um tom inventado.
    expect(screen.getByTestId("cor-nome-e2").textContent).toBe("Padrão");
  });

  it("escolher um tom manda `color` no PATCH da etapa — o campo que o quadro lê", async () => {
    const user = userEvent.setup();
    montarTela();
    await waitFor(() => expect(screen.getByTestId(`cor-${ETAPA}`)).toBeTruthy());

    await user.click(screen.getByTestId(`cor-${ETAPA}`));
    await user.click(await screen.findByTestId("tom-3e63dd"));

    await waitFor(() =>
      expect(apiClient.patch).toHaveBeenCalledWith(
        `/api/v1/pipelines/${PIPE}/stages/${ETAPA}`,
        { color: "#3e63dd" },
      ),
    );
  });

  it("«Padrão» devolve o valor de hoje: `color: null`, e não o tom anterior", async () => {
    const user = userEvent.setup();
    montarTela();
    await waitFor(() => expect(screen.getByTestId(`cor-${ETAPA}`)).toBeTruthy());

    await user.click(screen.getByTestId(`cor-${ETAPA}`));
    await user.click(await screen.findByTestId(`padrao-${ETAPA}`));

    await waitFor(() =>
      expect(apiClient.patch).toHaveBeenCalledWith(
        `/api/v1/pipelines/${PIPE}/stages/${ETAPA}`,
        { color: null },
      ),
    );
  });
});

describe("② a operação de etapa grava a coluna `color`, com auditoria igual à dos outros campos", () => {
  const etapaGravada = (over: Record<string, unknown> = {}) => ({
    id: ETAPA,
    name: "Carrinho abandonado",
    slug: "carrinho-abandonado",
    position: 1,
    color: null,
    is_won: false,
    is_lost: false,
    is_archived: false,
    win_probability: null,
    agent_stage_hint: null,
    last_change_actor_kind: null,
    last_change_at: null,
    ...over,
  });

  function supabaseDeSessao(linhas: Record<string, unknown>[], updates: Record<string, unknown>[]) {
    return {
      from(tabela: string) {
        const q = {
          select: () => q,
          eq: () => q,
          order: async () => ({ data: linhas, error: null }),
          maybeSingle: async () => ({
            data: tabela === "crm_pipelines" ? { id: PIPE } : null,
            error: null,
          }),
          update: (patch: Record<string, unknown>) => {
            updates.push(patch);
            const u = {
              eq: () => u,
              then: (ok: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(ok),
            };
            return u;
          },
        };
        return q;
      },
    };
  }

  const deps = (supabase: unknown, requestId = "r1") => ({
    supabase: supabase as never,
    organizationId: ORG,
    actor: { type: "user", id: "u1", role: "manager" } as never,
    requestId,
  });

  it("o PATCH de cor grava a coluna `color` e SÓ ela, com a autoria", async () => {
    const updates: Record<string, unknown>[] = [];
    await atualizarEtapa(deps(supabaseDeSessao([etapaGravada()], updates)), {
      pipelineId: PIPE,
      stageId: ETAPA,
      pedido: { color: "#3E63DD" },
    });

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ color: "#3e63dd", last_change_actor_kind: "user" });
    expect(Object.keys(updates[0]!).sort()).toEqual([
      "color",
      "last_change_actor_kind",
      "last_change_at",
    ]);
  });

  it("`color: null` volta ao padrão de hoje e é gravado como NULL", async () => {
    const updates: Record<string, unknown>[] = [];
    await atualizarEtapa(deps(supabaseDeSessao([etapaGravada({ color: "#3e63dd" })], updates)), {
      pipelineId: PIPE,
      stageId: ETAPA,
      pedido: { color: null },
    });
    expect(updates[0]).toMatchObject({ color: null });
  });

  it("cor fora da forma do banco é recusada com frase em português, ANTES do banco", async () => {
    const updates: Record<string, unknown>[] = [];
    await expect(
      atualizarEtapa(deps(supabaseDeSessao([etapaGravada()], updates), "r2"), {
        pipelineId: PIPE,
        stageId: ETAPA,
        pedido: { color: "verde" },
      }),
    ).rejects.toMatchObject({ status: 422 });
    expect(updates).toHaveLength(0);
  });

  it("a leitura devolve a cor da etapa (e nada para quem não tem)", () => {
    const comCor = corpo([etapaGravada({ color: "#3E63DD" }) as never]).etapas[0]!;
    const semCor = corpo([etapaGravada() as never]).etapas[0]!;
    expect(comCor.color).toBe("#3e63dd");
    expect(semCor.color).toBeNull();
  });
});

describe("③ o quadro pinta o MESMO campo que a tela gravou", () => {
  const base: Stage = {
    id: ETAPA,
    organization_id: ORG,
    pipeline_id: PIPE,
    name: "Carrinho abandonado",
    slug: "carrinho-abandonado",
    position: 1,
    color: null,
    is_won: false,
    is_lost: false,
    is_archived: false,
    expected_duration_hours: null,
  };

  /** O ponto do cabeçalho é o único `rounded-full` antes do nome da coluna. */
  function pontoDaColuna(container: HTMLElement): HTMLElement {
    const cabecalho = container.querySelector("[data-cabecalho-da-etapa]")!;
    const ponto = cabecalho.querySelector("span.rounded-full");
    expect(ponto).not.toBeNull();
    return ponto as HTMLElement;
  }

  it("a cor que a tela mandou vira o fundo do ponto no quadro", () => {
    // A cor percorre o caminho: payload da tela → linha de `crm_stages` →
    // coluna do quadro. É a MESMA string, sem tradução no meio.
    const enviadoPelaTela = { color: "#3e63dd" };
    const linhaGravada = { ...base, color: enviadoPelaTela.color };

    const { container } = render(
      <StageColumn stage={linhaGravada} leads={[]} pipelineId={PIPE} />,
    );

    // jsdom normaliza hex para rgb — o valor é o mesmo, conferido por conversão.
    expect(pontoDaColuna(container).style.backgroundColor).toBe("rgb(62, 99, 221)");
  });

  it("sem cor (o padrão de hoje) o ponto sai NEUTRO, sem estilo inline", () => {
    const { container } = render(<StageColumn stage={base} leads={[]} pipelineId={PIPE} />);
    expect(pontoDaColuna(container).style.backgroundColor).toBe("");
  });
});
