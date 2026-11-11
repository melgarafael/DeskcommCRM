// app/app/leads/[id]/pagina/pagina-do-negocio.test.tsx
import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PaginaDoNegocio } from "./_pagina";
import type { Pipeline, Stage } from "@/lib/kanban/types";
import type { Lead } from "@/lib/types/leads";

/**
 * A PÁGINA INTEIRA DO NEGÓCIO (#4151).
 *
 * ─── O que este arquivo mede, e o que ele NÃO mede ─────────────────────────
 *
 * Mede a MOLDURA: o negócio é o título da página, a etapa está no cabeçalho, os
 * blocos do dossiê estão montados (campos, tarefas, linha do tempo, contato) e o
 * layout nasce de UMA coluna, virando duas só a partir do breakpoint grande. É a
 * diferença entre "a rota deixou de redirecionar" e "a rota devolve a mesma
 * gaveta de 28rem com outro endereço".
 *
 * Não mede o interior de cada bloco — eles têm teste próprio (LeadFieldsForm,
 * TarefasDoNegocio, LeadTimeline…), e um teste de composição que reimplementasse
 * as asserções de todos viraria a segunda implementação que ele deveria impedir.
 * Por isso as peças são substituídas por marcadores, como em `LeadDossier.test`.
 */

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useTagDeIdioma: () => "pt-BR" }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useUser: () => ({ id: "u1", is_platform_admin: false, support: false }),
  useActiveOrg: () => ({ role: "manager", currency: "BRL" }),
  useMoedaDaOrgAtiva: () => null,
  usePermission: () => true,
}));
vi.mock("@/hooks/leads/useLeadTimeline", () => ({
  useLeadTimeline: () => ({
    itens: [{ id: "a1", type: "stage_changed" }],
    chegouAoVivo: new Set<string>(),
    isLoading: false,
    isError: false,
    realtimeStatus: "connected",
    seguranca: { divergencias: 0 },
  }),
}));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({
  useAssignableMembers: () => ({ data: [{ user_id: "u1", full_name: "Ana" }] }),
}));
// A mutação de etapa é do quadro e tem teste próprio (`useMoveCard`); aqui ela
// só precisa existir para o cabeçalho ser vivo.
vi.mock("@/hooks/kanban/useMoveCard", () => ({
  useMoveCard: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/components/kanban/ContatoDoNegocio", () => ({
  ContatoDoNegocio: () => <div data-peca="contato" />,
}));
vi.mock("@/components/kanban/LeadFieldsForm", () => ({
  LeadFieldsForm: () => <div data-peca="campos" />,
}));
vi.mock("@/components/kanban/RevisaoDoDocumento", () => ({ RevisaoDoDocumento: () => null }));
vi.mock("@/components/kanban/TarefasDoNegocio", () => ({
  TarefasDoNegocio: () => <div data-peca="tarefas" />,
}));
vi.mock("@/components/kanban/PropostasDoNegocio", () => ({
  PropostasDoNegocio: () => <div data-peca="propostas" />,
}));
vi.mock("@/components/kanban/ConversaNoDossie", () => ({ ConversaNoDossie: () => null }));
vi.mock("@/components/kanban/ScoreSlot", () => ({ ScoreSlot: () => null }));
vi.mock("@/components/kanban/OwnerBadge", () => ({ OwnerBadge: () => null }));
vi.mock("@/components/kanban/LeadTimeline", () => ({
  LeadTimeline: () => <ul data-peca="linha-do-tempo" />,
}));

const LEAD = {
  id: "lead-1",
  organization_id: "org-1",
  pipeline_id: "funil-1",
  stage_id: "etapa-1",
  contact_id: "contato-1",
  title: "Viagem Rio",
  description: "Duas passagens, ida e volta.",
  status: "open",
  lost_reason: null,
  position_in_stage: 1000,
  value_cents: 250000,
  currency: "BRL",
  owner_kind: null,
  owner_user_id: null,
  owner_agent_id: null,
  owner_agent: null,
  score: null,
  conversa: null,
  updated_at: "2026-11-08T12:00:00.000Z",
} as unknown as Lead;

const ETAPAS = [
  { id: "etapa-1", name: "Novo" },
  { id: "etapa-2", name: "Negociação" },
] as unknown as Stage[];

const PIPELINE = { id: "funil-1", settings: {} } as unknown as Pipeline;

function montar() {
  // A camada de dados (react-query) é exigida pelos diálogos que a página monta
  // fechados — o motivo da perda e os campos obrigatórios.
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PaginaDoNegocio
        lead={LEAD}
        pipeline={PIPELINE}
        etapas={ETAPAS}
        voltarHref="/app/pipelines/funil-1?tag=quente"
      />
    </QueryClientProvider>,
  );
}

/** Os tokens de classe, para não confundir `grid-cols-2` com `lg:grid-cols-2`. */
function classesDoLayout(): string[] {
  return screen.getByTestId("negocio-colunas").className.split(/\s+/).filter(Boolean);
}

describe("a página do negócio (#4151)", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("⭐ o negócio é o título da página, e o cabeçalho traz a etapa", () => {
    montar();

    expect(screen.getByRole("heading", { level: 1, name: "Viagem Rio" })).toBeInTheDocument();
    // O seletor de etapa do dossiê, montado com as etapas do funil: "mudar
    // etapa" funciona na página pelo MESMO bloco do painel.
    expect(screen.getByTestId("dossie-etapa")).toBeInTheDocument();
  });

  it("⭐ monta os blocos do negócio — contato, campos, tarefas e linha do tempo", () => {
    montar();

    for (const peca of ["contato", "campos", "tarefas", "linha-do-tempo", "propostas"]) {
      expect(document.querySelector(`[data-peca="${peca}"]`), `falta a peça ${peca}`).not.toBeNull();
    }
  });

  it("⭐ o voltar aponta para o quadro COM o filtro, e a página não tem expandir", () => {
    montar();

    const voltar = screen.getByTestId("negocio-voltar");
    expect(voltar).toHaveAttribute("href", "/app/pipelines/funil-1?tag=quente");
    expect(voltar).toHaveTextContent("Voltar");
    // Expandir é do PAINEL; numa página inteira o botão não teria destino.
    expect(screen.queryByTestId("dossie-expandir")).toBeNull();
  });

  it("⭐ nasce de UMA coluna e vira duas só no desktop", () => {
    montar();

    const classes = classesDoLayout();
    // Uma coluna por padrão — é o comportamento de hoje, preservado na tela
    // estreita (e é o que o `grid-cols-1` garante, não o acaso do conteúdo).
    expect(classes).toContain("grid-cols-1");
    for (const duasColunas of ["grid-cols-2", "sm:grid-cols-2", "md:grid-cols-2"]) {
      expect(classes, `duas colunas em tela estreita por ${duasColunas}`).not.toContain(duasColunas);
    }
    // Duas, a partir do breakpoint grande.
    expect(classes).toContain("lg:grid-cols-2");
  });

  it("dados e descrição à esquerda; tarefas e linha do tempo à direita", () => {
    montar();

    const colunas = screen.getByTestId("negocio-colunas");
    const esquerda = colunas.children[0] as HTMLElement;
    const direita = colunas.children[1] as HTMLElement;

    expect(within(esquerda).getByText("Contato")).toBeInTheDocument();
    expect(within(esquerda).getByText("Dados do negócio")).toBeInTheDocument();
    expect(within(esquerda).queryByText("Linha do tempo")).toBeNull();
    expect(within(direita).queryByText("Dados do negócio")).toBeNull();
    // Tarefas e propostas são blocos próprios (aqui substituídos por
    // marcadores); a linha do tempo tem o título da seção.
    expect(direita.querySelector('[data-peca="tarefas"]')).not.toBeNull();
    expect(within(direita).getByText("Linha do tempo")).toBeInTheDocument();
  });
});
