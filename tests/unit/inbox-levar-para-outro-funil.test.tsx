import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { CRMSidePanel } from "@/components/inbox/CRMSidePanel";
import { ApiError } from "@/lib/api/types";

/**
 * LEVAR O NEGÓCIO PARA OUTRO FUNIL SEM SAIR DA CONVERSA (issue #2874).
 *
 * O painel já deixava trocar a ETAPA dentro do funil atual (`EtapaDoNegocio`).
 * Mudar de FUNIL exigia sair da conversa, abrir o Kanban, achar o card e usar
 * "Levar para outro funil" lá. Esta fatia traz a MESMA ação para o lead ativo de
 * "Leads recentes", reusando o diálogo do quadro
 * (`components/kanban/MoveToOtherPipelineDialog`) e a rota
 * `POST /api/v1/leads/[id]/clone` — nada de transferência é reimplementado.
 *
 * Estes casos cobrem, um a um, os seis critérios de aceite da issue:
 *  1) a ação aparece no lead ativo, ao lado de "Etapa do funil";
 *  2) o diálogo lista só os funis de destino válidos — o funil atual fica de fora;
 *  3) ao confirmar, o painel recarrega, o negócio NOVO vira o ATIVO e a origem
 *     aparece encerrada;
 *  4) sem permissão de mover o negócio (viewer), a ação não aparece;
 *  5) o erro da rota vira toast — o mesmo `showApiError` do quadro — e o diálogo
 *     fica aberto para o operador corrigir.
 */

// O portão do Kanban para "Levar para outro funil" é `pipeline.move_card`
// (agent+). O dublê devolve o PAPEL da organização ativa, que é o que a régua
// resolve; `viewer` cai para fora do piso de `agent`.
const estado = vi.hoisted(() => ({ papel: "agent" as "agent" | "viewer" }));
const get = vi.hoisted(() => vi.fn());
const post = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: (...args: unknown[]) => get(...args),
    post: (...args: unknown[]) => post(...args),
    patch: vi.fn(),
  },
}));
vi.mock("@/hooks/pipelines/useDefaultPipeline", () => ({
  useDefaultPipeline: () => ({ data: null, isError: false }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock("@/hooks/inbox/useConversationTags", () => ({
  useUpdateConversationTags: () => ({ mutate: vi.fn(), isPending: false }),
  useConversationTagVocabulary: () => ({ data: [] }),
}));
vi.mock("@/hooks/contacts/useContactTagVocabulary", () => ({
  useContactTagVocabulary: () => ({ data: [] }),
}));
vi.mock("@/hooks/contacts/useUpdateContact", () => ({
  useUpdateContact: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({
    user: { support: null, is_platform_admin: false },
    activeOrg: { orgId: "org-1", name: "Org", role: estado.papel },
  }),
}));
// Busca o acervo por conta própria e não é o alvo desta fatia: fica fora da
// conta para os GETs do resumo serem os únicos observáveis.
vi.mock("@/components/contacts/RoteirosDoContato", () => ({ RoteirosDoContato: () => null }));
// O bloco Carteira (#3026) busca a própria rota; o dublê de `get` deste arquivo
// devolve o resumo do painel para TODA URL, então o cartão sai da cena aqui.
vi.mock("@/components/contacts/CartaoDaCarteira", () => ({ CartaoDaCarteira: () => null }));

// O Select do Radix pede estas APIs do navegador, que o jsdom não implementa.
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
window.HTMLElement.prototype.setPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();

const CONTATO = "c0000000-0000-4000-8000-000000000001";

const conversation = {
  id: "cv-1",
  organization_id: "org-1",
  contact_id: CONTATO,
  tags: [],
  contacts: { id: CONTATO, display_name: "Fulana", name: null, phone_number: "5511999", tags: [] },
} as unknown as React.ComponentProps<typeof CRMSidePanel>["conversation"];

type Linha = Record<string, unknown>;

/** O que `crm-summary` devolve: o embed já resolvido em nome de funil e etapa. */
function lead(
  id: string,
  pipelineId: string,
  funil: string,
  etapa: string,
  status: string,
): Linha {
  return {
    id,
    title: "Felipe",
    status,
    value_cents: null,
    currency: null,
    updated_at: "2026-09-15T12:00:00Z",
    pipeline_id: pipelineId,
    stage_id: "s-1",
    custom_fields: {},
    field_defs: [],
    funil_nome: funil,
    etapa_nome: etapa,
    etapas_do_funil: [{ id: "s-1", name: etapa, is_won: false, is_lost: false }],
  };
}

function resumo(leads: Linha[]) {
  return { data: { leads, orders: [], activities: [], demandas: [], fatos: [], historico: [] } };
}

/**
 * `GET /api/v1/leads/[id]/clone` — a lista JÁ vem sem o funil atual (a rota o
 * exclui) e, desde a #3643, com as etapas de cada destino: é delas que sai o
 * seletor de "Etapa de entrada".
 */
const DESTINOS = [
  {
    id: "p-2",
    name: "Funil Destino",
    stages: [{ id: "s-2", name: "Novo", position: 1000, is_won: false, is_lost: false }],
  },
];

function implementarLeituras(leadsAtuais: () => Linha[]) {
  get.mockImplementation(async (url: string) =>
    String(url).endsWith("/clone")
      ? { data: { pipelines: DESTINOS } }
      : resumo(leadsAtuais()),
  );
}

function renderPainel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CRMSidePanel conversation={conversation} />
    </QueryClientProvider>,
  );
}

/** As leituras do RESUMO — separadas das do `/clone` na hora de contar/afirmar. */
const leiturasDoResumo = () =>
  get.mock.calls.filter((c) => String(c[0]).includes("crm-summary")).length;

// Dois negócios: com um só, o painel usa o layout `inbox-lead-unico` e não há
// lista por id. O primeiro é o ativo (sem escolha, o painel usa `leads[0]`).
const INICIAL = [
  lead("l-1", "p-1", "Origem", "Novo", "open"),
  lead("l-0", "p-0", "Outro funil", "Novo", "open"),
];

beforeEach(() => {
  estado.papel = "agent";
  get.mockReset();
  post.mockReset();
});

describe("painel do inbox — Levar para outro funil", () => {
  it("1. a ação aparece no lead ativo, ao lado de 'Etapa do funil'", async () => {
    get.mockResolvedValue(resumo(INICIAL));
    renderPainel();

    await screen.findByTestId("inbox-lead-l-1");
    const acao = screen.getByTestId("inbox-levar-para-outro-funil");
    expect(acao.textContent).toContain("Levar para outro funil");
    // "ao lado de Etapa do funil": as duas convivem no bloco do negócio ativo.
    expect(screen.getByRole("combobox", { name: "Etapa do funil" })).toBeTruthy();
  });

  it("2. o diálogo lista só os funis de destino válidos — o atual fica de fora", async () => {
    implementarLeituras(() => INICIAL);
    renderPainel();
    const user = userEvent.setup();

    await user.click(await screen.findByTestId("inbox-levar-para-outro-funil"));

    const seletor = await screen.findByRole("combobox", { name: "Funil de destino" });
    await user.click(seletor);
    const opcoes = (await screen.findAllByRole("option")).map((o) => o.textContent);
    expect(opcoes).toEqual(["Funil Destino"]);
    expect(opcoes).not.toContain("Origem");
    // A lista vem da rota que já exclui o funil ATUAL do negócio.
    expect(get).toHaveBeenCalledWith("/api/v1/leads/l-1/clone");
  });

  it("3. confirmar recarrega o painel: o negócio novo vira o ATIVO e a origem aparece encerrada", async () => {
    let atual = INICIAL;
    implementarLeituras(() => atual);
    post.mockImplementation(async () => {
      // A rota cria o negócio no destino e encerra a origem com o motivo canônico.
      atual = [
        lead("l-2", "p-2", "Funil Destino", "Novo", "open"),
        lead("l-1", "p-1", "Origem", "Perdido", "lost"),
        lead("l-0", "p-0", "Outro funil", "Novo", "open"),
      ];
      return { data: { lead: {}, origem: {} } };
    });
    renderPainel();
    const user = userEvent.setup();

    await screen.findByTestId("inbox-lead-l-1");
    const leiturasAntes = leiturasDoResumo();

    await user.click(screen.getByTestId("inbox-levar-para-outro-funil"));
    await user.click(await screen.findByRole("combobox", { name: "Funil de destino" }));
    await user.click(await screen.findByRole("option", { name: "Funil Destino" }));
    await user.click(screen.getByRole("button", { name: "Confirmar" }));

    // Mesma rota do Kanban: o destino vai como `pipeline_id`.
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/leads/l-1/clone", { pipeline_id: "p-2" }),
    );
    // O painel recarregou o resumo (não usa react-query: invalidação não o alcança).
    await waitFor(() => expect(leiturasDoResumo()).toBeGreaterThan(leiturasAntes));

    const novo = await screen.findByTestId("inbox-lead-l-2");
    expect(novo.getAttribute("aria-pressed")).toBe("true");
    expect(novo.textContent).toContain("Funil Destino · Novo");
    expect(novo.textContent).toContain("Aberto");
    // A origem segue na lista, agora ENCERRADA.
    const origem = screen.getByTestId("inbox-lead-l-1");
    expect(origem.getAttribute("aria-pressed")).toBe("false");
    expect(origem.textContent).toContain("Perdido");
  });

  it("4. sem permissão de mover o negócio, a ação não aparece", async () => {
    estado.papel = "viewer";
    get.mockResolvedValue(resumo(INICIAL));
    renderPainel();

    // Controle de vacuidade: o bloco do negócio desenhou — a AÇÃO é que não.
    await screen.findByTestId("inbox-lead-l-1");
    expect(screen.queryByTestId("inbox-levar-para-outro-funil")).toBeNull();
  });

  it("5. o erro da rota vira toast (igual ao quadro) e o diálogo fica aberto", async () => {
    const { toast } = await import("sonner");
    vi.mocked(toast.error).mockClear();
    vi.mocked(toast.success).mockClear();
    implementarLeituras(() => INICIAL);
    post.mockRejectedValue(
      new ApiError(
        422,
        "pipeline_no_lost_stage",
        undefined,
        "req-1",
        "O funil de origem não tem etapa de perda.",
      ),
    );
    renderPainel();
    const user = userEvent.setup();

    await user.click(await screen.findByTestId("inbox-levar-para-outro-funil"));
    await user.click(await screen.findByRole("combobox", { name: "Funil de destino" }));
    await user.click(await screen.findByRole("option", { name: "Funil Destino" }));
    await user.click(screen.getByRole("button", { name: "Confirmar" }));

    await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalled());
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
    // O diálogo NÃO fecha no erro: o operador lê o motivo e corrige o destino.
    expect(screen.getByRole("button", { name: "Confirmar" })).toBeTruthy();
  });
});
