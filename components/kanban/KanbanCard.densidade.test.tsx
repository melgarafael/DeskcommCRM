import { DragDropContext, Droppable } from "@hello-pangea/dnd";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildCardInput } from "@/lib/kanban/card-state";
import type { Lead } from "@/lib/types/leads";

import { KanbanCard } from "./KanbanCard";

/**
 * #3461, item 2 — o card COMPACTO mostra os mesmos dados essenciais que o
 * confortável, e o que ele não mostra continua alcançável no dossiê.
 *
 * ─── O que este arquivo prova, e o que ele NÃO prova ────────────────────────
 *
 * Prova, olhando a ÁRVORE renderizada: o card compacto mantém título (inteiro
 * no `title`, uma linha na tela), valor, dono, tempo na etapa e a faixa do
 * agente; e tira de cima dele a última mensagem e o bloco de contato — que é a
 * decisão declarada do PR, e cujo destino (o dossiê) é conferido na FONTE, no
 * caso `o que sai do card compacto continua no dossiê`.
 *
 * NÃO prova altura em pixel: o jsdom não faz layout. A altura é medida no e2e,
 * onde há navegador de verdade.
 */

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  usePermission: () => true,
  useUser: () => ({ id: "u-1" }),
  useActiveOrg: () => ({ orgId: "o-1", currency: "BRL" }),
}));
// Os diálogos do menu de ações não fazem parte desta medida: o que se olha aqui
// é o CORPO do card. Dublados, eles não arrastam a org, a moeda e as rotas de
// cada um para dentro do caso.
vi.mock("./EditLeadDialog", () => ({ EditLeadDialog: () => null }));
vi.mock("./LoseLeadDialog", () => ({ LoseLeadDialog: () => null }));
vi.mock("./MoveToOtherPipelineDialog", () => ({ MoveToOtherPipelineDialog: () => null }));
vi.mock("@/hooks/kanban/useUpdateLead", () => ({
  useWinLead: () => ({ mutate: vi.fn(), isPending: false }),
  useEditLead: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({
  useAssignableMembers: () => ({ data: [] }),
}));
vi.mock("@/hooks/kanban/useAssignableAgents", () => ({
  useAssignableAgents: () => ({ data: [] }),
}));
vi.mock("@/lib/api/client", () => ({
  apiClient: { post: vi.fn(), get: vi.fn(), patch: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...resto }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...resto}>
      {children}
    </a>
  ),
}));

const AGORA = new Date("2026-10-27T12:00:00Z");
/** 5 dias parado na etapa: dá idade para o rodapé escrever "5d em Negociação". */
const ENTRADA_NA_ETAPA = "2026-10-22T12:00:00Z";

const LEAD = {
  id: "l-1",
  title: "Proposta da ACME — renovação anual de contrato",
  value_cents: 250_000,
  currency: "BRL",
  tags: ["vip"],
  stage_changed_at: ENTRADA_NA_ETAPA,
  created_at: ENTRADA_NA_ETAPA,
  owner_kind: "user",
  owner_user_id: "u-1",
  owner_agent_id: null,
  owner_agent: null,
  owner_user: { full_name: "Marcos" },
  next_action: null,
  score: null,
  contact_id: "c-1",
  contact_phone: "+55 11 98888-7777",
  contact_email: "ana@exemplo.com",
  contact_links: [],
  conversa: {
    id: "conv-1",
    preview: "Quero saber o preço",
    last_message_at: "2026-10-26T10:00:00Z",
    unread: 0,
  },
  tarefas: [],
} as unknown as Lead;

function montar(denso: boolean) {
  const cliente = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const card = buildCardInput(LEAD, {
    stageName: "Negociação",
    ownerNames: new Map([["u-1", "Marcos"]]),
    coolingIds: new Set<string>(),
    reactivations: new Map(),
    canonicalTags: [],
    now: AGORA,
  });
  return render(
    <QueryClientProvider client={cliente}>
      <DragDropContext onDragEnd={() => undefined}>
        <Droppable droppableId="etapa-1" type="LEAD">
          {() => (
            <div>
              <KanbanCard
                card={card}
                lead={LEAD}
                index={0}
                pipelineId="p-1"
                etapas={[]}
                denso={denso}
              />
            </div>
          )}
        </Droppable>
      </DragDropContext>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("card compacto × confortável (#3461, item 2)", () => {
  it("o confortável mostra a conversa e o contato", () => {
    const { container } = montar(false);
    expect(container.querySelector('[data-densidade="confortavel"]')).toBeTruthy();
    expect(screen.getByText("Quero saber o preço")).toBeInTheDocument();
    expect(screen.getByTestId("contato-no-card")).toBeInTheDocument();
  });

  it("o compacto mantém título, valor, dono e tempo na etapa", () => {
    const { container } = montar(true);
    const cartao = container.querySelector('[data-densidade="compacta"]') as HTMLElement;
    expect(cartao).toBeTruthy();
    // Título inteiro no `title` do cabeçalho (a linha visível é uma só, e o
    // texto não some). O texto mora num `<button>` dentro do `<h3>`, por isso a
    // asserção é no cabeçalho, não no nó que carrega o texto.
    const cabecalho = cartao.querySelector("h3");
    expect(cabecalho).toHaveTextContent(LEAD.title);
    expect(cabecalho).toHaveAttribute("title", LEAD.title);
    // Valor e dono continuam no card.
    expect(within(cartao).getByText(/2\.500/)).toBeInTheDocument();
    expect(within(cartao).getByText(/Marcos/)).toBeInTheDocument();
    // E o tempo na etapa também.
    expect(within(cartao).getByText(/Negociação/)).toBeInTheDocument();
  });

  it("o compacto tira do card a conversa e o contato — e é isto que o PR declara", () => {
    const { container } = montar(true);
    const cartao = container.querySelector('[data-densidade="compacta"]') as HTMLElement;
    expect(within(cartao).queryByText("Quero saber o preço")).toBeNull();
    expect(within(cartao).queryByTestId("contato-no-card")).toBeNull();
  });

  it("o que sai do card compacto continua no dossiê (a decisão, lida na fonte)", () => {
    const raiz = process.cwd();
    const dossie = readFileSync(join(raiz, "components/kanban/LeadDossier.tsx"), "utf8");
    // As duas linhas que o compacto esconde têm lugar próprio no dossiê: a
    // última mensagem em `ConversaNoDossie`, telefone/e-mail/links em
    // `ContatoDoNegocio`. Sem estas duas, "sai para o detalhe" seria desculpa.
    expect(dossie).toContain("ConversaNoDossie");
    expect(dossie).toContain("ContatoDoNegocio");
  });
});
