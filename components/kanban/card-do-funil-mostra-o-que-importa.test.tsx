import { DragDropContext, Droppable } from "@hello-pangea/dnd";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildCardInput } from "@/lib/kanban/card-state";
import type { Lead } from "@/lib/types/leads";

import { KanbanCard } from "./KanbanCard";

/**
 * AS QUATRO PERGUNTAS DO CARD — no card renderizado, não na função pura
 * (fatia 1 do #3945).
 *
 * ─── Por que este arquivo existe ───────────────────────────────────────────
 *
 * O quadro já tinha peças para responder "quanto vale", "quem toca" e "há quanto
 * tempo está aí"; a issue relata o card com um traço e "Sem responsável" porque
 * nada disso chegava à TELA. Um teste de `buildCardInput` provaria que o objeto
 * está montado — e não que o card o desenha. Aqui a montagem é a de produção
 * (`buildCardInput` → `KanbanCard`) e a medida é a árvore renderizada.
 *
 * Cada caso prende UMA das quatro perguntas. É de propósito: a sabotagem do PR
 * remove um campo do payload de cada vez, e o vermelho tem de apontar a pergunta
 * que ficou sem resposta — não "o card mudou".
 *
 * O que NÃO se mede aqui: altura em pixel (o jsdom não faz layout) e a régua da
 * hora (essa mora em `lib/i18n/hora-curta.test.ts`).
 */

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  usePermission: () => true,
  useUser: () => ({ id: "u-1" }),
  useActiveOrg: () => ({ orgId: "o-1", currency: "BRL" }),
}));
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

const AGORA = new Date("2026-11-07T12:00:00Z");
/** 5 dias parado na etapa → o rodapé escreve "5d em Negociação". */
const ENTRADA_NA_ETAPA = "2026-11-02T12:00:00Z";
/** 30 minutos atrás: a última mensagem é de HOJE, então o rótulo é a HORA. */
const ULTIMA_MENSAGEM = "2026-11-07T11:30:00Z";

const LEAD: Lead = {
  id: "l-1",
  title: "ACME — renovação anual",
  value_cents: 250_000,
  recurring_value_cents: null,
  recurring_period: null,
  currency: "BRL",
  tags: [],
  stage_changed_at: ENTRADA_NA_ETAPA,
  created_at: ENTRADA_NA_ETAPA,
  owner_kind: "user",
  owner_user_id: "u-1",
  owner_agent_id: null,
  owner_agent: null,
  next_action: null,
  score: null,
  contact_id: "c-1",
  contact_phone: "+55 11 98888-7777",
  contact_email: null,
  contact_links: [],
  conversa: {
    id: "conv-1",
    preview: "Quero saber o preço do plano anual",
    last_message_at: ULTIMA_MENSAGEM,
    unread: 0,
  },
  tarefas: [],
} as unknown as Lead;

function montar(lead: Lead = LEAD) {
  const cliente = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const card = buildCardInput(lead, {
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
              <KanbanCard card={card} lead={lead} index={0} pipelineId="p-1" etapas={[]} />
            </div>
          )}
        </Droppable>
      </DragDropContext>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // O RELÓGIO DA RÉGUA É O DO SISTEMA, e `.test.tsx` não recebe `agora` por
  // parâmetro: `ConversaSlot` chama `horaCurta(iso, locale)` e a função toma
  // `new Date()`. Sem congelar aqui, este arquivo mede o dia em que a suíte
  // roda — a fixture diz "30 minutos atrás" e a régua, depois da meia-noite
  // (UTC no CI, -03 aqui), responde "14 horas". Congelar em AGORA mantém a
  // leitura de contrato: "hoje" é o mesmo DIA CIVIL (`hora-curta.ts`, faixa
  // `hoje`), e ULTIMA_MENSAGEM está dentro dele.
  vi.useFakeTimers({ now: AGORA.getTime(), shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("o card do funil mostra o que importa (#3945, fatia 1)", () => {
  it("⭐ QUANTO VALE — o valor do negócio, e não um traço", () => {
    montar();

    const valor = screen.getByTestId("card-valor");
    expect(valor).toHaveTextContent(/2\.500/);
    expect(valor).not.toHaveTextContent("—");
  });

  it("⭐ QUANTO VALE (recorrente) — a mensalidade ao lado, nunca somada", () => {
    montar({
      ...LEAD,
      recurring_value_cents: 50_000,
      recurring_period: "monthly",
    } as Lead);

    const valor = screen.getByTestId("card-valor");
    expect(valor).toHaveTextContent(/2\.500/);
    expect(valor).toHaveTextContent(/500/);
    // Os dois números aparecem; a soma (3.000) NÃO é o que o card escreve.
    expect(valor).not.toHaveTextContent(/3\.000/);
  });

  it("⭐ O QUE ELE DISSE — a última mensagem no card, com a hora de quando foi", () => {
    const { container } = montar();

    expect(screen.getByText("Quero saber o preço do plano anual")).toBeInTheDocument();
    const hora = container.querySelector("[data-hora-da-mensagem]");
    expect(hora).toBeTruthy();
    // É hoje, então o rótulo é a hora — e não a data.
    expect(hora!.textContent).toMatch(/^\d{2}:\d{2}$/);
  });

  it("⭐ QUEM TOCA — o nome do responsável humano, e não 'Sem responsável'", () => {
    const { container } = montar();

    const cartao = container.querySelector('[data-densidade="confortavel"]') as HTMLElement;
    expect(within(cartao).getByText(/Marcos/)).toBeInTheDocument();
    expect(within(cartao).queryByText("Sem responsável")).toBeNull();
  });

  it("⭐ QUEM TOCA (IA) — o agente aparece com nome e versão", () => {
    const { container } = montar({
      ...LEAD,
      owner_kind: "ai",
      owner_user_id: null,
      owner_agent_id: "a-1",
      owner_agent: { id: "a-1", name: "Atendente ACME", version_number: 3 },
    } as unknown as Lead);

    const cartao = container.querySelector('[data-densidade="confortavel"]') as HTMLElement;
    expect(within(cartao).getByText(/Atendente ACME/)).toBeInTheDocument();
    // A versão mora no rótulo acessível/title do badge (a linha visível é o
    // nome): é a distinção entre "o bot" e "a versão do bot que atendeu".
    expect(within(cartao).getByLabelText("Responsável: Atendente ACME · v3")).toBeInTheDocument();
  });

  it("⭐ HÁ QUANTO TEMPO NA ETAPA — conta da ENTRADA na etapa", () => {
    const { container } = montar();

    const cartao = container.querySelector('[data-densidade="confortavel"]') as HTMLElement;
    expect(within(cartao).getByText(/5d em Negociação/)).toBeInTheDocument();
  });
});
