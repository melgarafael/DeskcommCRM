import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * RECOLHER O PAINEL DO CONTATO (issue #3004) — o painel inteiro, não as seções.
 *
 * Até aqui só o menu da esquerda tinha como recolher: quem trazia o Inbox num
 * monitor via a ficha do contato ocupando a direita sem nenhum jeito de dar
 * aquela largura à conversa. Estes casos prendem as duas metades da entrega:
 *
 *   1. o CLIQUE — recolher esconde o painel e um segundo clique o traz de volta
 *      (e o trilho recolhido sempre tem o botão de expandir, senão o painel
 *      sumiria sem porta de volta);
 *   2. a LARGURA — recolhido, a grade troca a trilha da ficha pelo trilho
 *      estreito, que é o que o pedido chama de "dar a largura toda à conversa";
 *   3. a PREFERÊNCIA — a tela começa pelo valor que o SERVIDOR leu do cookie
 *      (`painelRecolhidoInicial`), a mesma mecânica do `sidebar_collapsed` do
 *      menu da esquerda, e cada clique grava pelo mesmo server action.
 *
 * O estado mora na GRADE (`InboxLayout`) e não no painel: quem redistribui a
 * largura é a grade, e o painel só desenha o controle. Por isso o alvo aqui é o
 * layout montado de verdade, com o `CRMSidePanel` real dentro.
 */

const get = vi.hoisted(() => vi.fn());
const togglePainelDoContato = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@/app/actions/inbox/togglePainelDoContato", () => ({ togglePainelDoContato }));

const ORG = "00000000-0000-4000-8000-0000000005aa";
const CONTATO = "c0000000-0000-4000-8000-000000000001";
const CONVERSA = "cv-1";

const conversa = {
  id: CONVERSA,
  organization_id: ORG,
  contact_id: CONTATO,
  channel_session_id: "cs-1",
  status: "open",
  tags: [],
  assigned_to_user_id: null,
  bot_silenced_until: null,
  service_revision: 1,
  current_demanda_id: null,
  last_inbound_at: "2026-09-15T12:00:00Z",
  unread_count_for_assignee: 0,
  channel_sessions: { provider: "waha" },
  contacts: {
    id: CONTATO,
    display_name: "Fulana",
    name: null,
    phone_number: "5511999",
    tags: [],
    is_anonymized: false,
  },
};

const resumo = {
  data: {
    leads: [
      {
        id: "l-1",
        title: "Felipe",
        status: "open",
        value_cents: null,
        currency: null,
        updated_at: "2026-09-15T12:00:00Z",
        pipeline_id: "p-1",
        stage_id: "s-1",
        custom_fields: {},
        field_defs: [],
        funil_nome: "Origem",
        etapa_nome: "Novo",
        etapas_do_funil: [{ id: "s-1", name: "Novo", is_won: false, is_lost: false }],
      },
    ],
    orders: [],
    activities: [],
    demandas: [],
    fatos: [],
    historico: [],
  },
};

get.mockImplementation(async (url?: string) => {
  const bruto = url ?? "";
  if (bruto === "/api/v1/ai/automatico-ativo") return { data: { ativo: false } };
  if (bruto.includes("crm-summary")) return resumo;
  return { data: [] };
});

vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: (...args: unknown[]) => get(...args),
    post: vi.fn(),
    patch: vi.fn(),
  },
}));
vi.mock("@/hooks/inbox/useConversationsRealtime", () => ({
  useConversationsRealtime: () => ({
    data: { pages: [{ data: [conversa] }] },
    realtimeStatus: "ok",
    seguranca: { divergencias: 0 },
  }),
}));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("@/lib/supabase/browser", () => ({
  prepareRealtimeAuthentication: vi.fn().mockResolvedValue(undefined),
  createClient: () => ({
    channel: () => ({ on: () => ({ subscribe: () => ({}) }), subscribe: () => ({}) }),
    removeChannel: () => {},
  }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/app/inbox",
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({
    user: { id: "u-1", role: "admin", support: null, is_platform_admin: false },
    activeOrg: { orgId: ORG, name: "Org", role: "admin" },
  }),
  usePermission: () => true,
}));
vi.mock("@/hooks/inbox/useMarkAsRead", () => ({ useMarkAsRead: () => undefined }));
vi.mock("@/hooks/inbox/useClaimConversation", () => ({
  useClaimConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useCloseConversation", () => ({
  useCloseConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));
// As irmãs do Inbox não são o alvo e trazem fetch próprio: ficam de fora da conta.
vi.mock("@/components/inbox/ConversationList", () => ({ ConversationList: () => null }));
vi.mock("@/components/inbox/InboxFilters", () => ({ InboxFilters: () => null }));
vi.mock("@/components/inbox/ChatThread", () => ({ ChatThread: () => null }));
vi.mock("@/components/inbox/Composer", () => ({ Composer: () => null }));
vi.mock("@/components/inbox/ConversationHeader", () => ({ ConversationHeader: () => null }));
vi.mock("@/components/inbox/RetentionNotice", () => ({ RetentionNotice: () => null }));
vi.mock("@/components/inbox/InboxKeyboardShortcuts", () => ({ InboxKeyboardShortcuts: () => null }));
vi.mock("@/components/inbox/ShortcutsHelpDialog", () => ({ ShortcutsHelpDialog: () => null }));
vi.mock("@/components/inbox/JanelaFechadaAviso", () => ({ JanelaFechadaAviso: () => null }));
vi.mock("@/components/inbox/NumeroForaDoAr", () => ({ NumeroForaDoAr: () => null }));
vi.mock("@/components/inbox/PainelIniciarConversa", () => ({ BotaoIniciarConversa: () => null }));
// Dependências do painel (o painel em si é REAL: é ele que desenha o controle).
vi.mock("@/hooks/pipelines/useDefaultPipeline", () => ({
  useDefaultPipeline: () => ({ data: null, isError: false, isLoading: false }),
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
vi.mock("@/components/contacts/RoteirosDoContato", () => ({ RoteirosDoContato: () => null }));

import { InboxLayout } from "@/components/inbox/InboxLayout";

beforeAll(() => {
  // A faixa `xl` é onde a ficha existe como coluna (`lg`/`md` não têm ficha).
  Object.defineProperty(window, "innerWidth", { value: 1440, configurable: true, writable: true });
  Element.prototype.getBoundingClientRect = function (): DOMRect {
    return {
      width: 1040,
      left: 0,
      right: 1040,
      top: 0,
      bottom: 800,
      x: 0,
      y: 0,
      height: 800,
      toJSON: () => ({}),
    } as DOMRect;
  };
  window.HTMLElement.prototype.setPointerCapture = vi.fn();
  window.HTMLElement.prototype.releasePointerCapture = vi.fn();
  window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  togglePainelDoContato.mockClear();
  window.localStorage.clear();
});

function montar(painelRecolhidoInicial = false) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <InboxLayout initialSelectedId={CONVERSA} painelRecolhidoInicial={painelRecolhidoInicial} />
    </QueryClientProvider>,
  );
}

/** A GRADE — é ela quem redistribui a largura entre lista, conversa e ficha. */
function grade(): HTMLElement {
  const el = document.querySelector<HTMLElement>("[data-realtime-status]");
  if (!el) throw new Error("a grade do Inbox não renderizou");
  return el;
}

const trilhaDaFicha = "xl:grid-cols-[272px_1fr_296px]";
const trilhaDoTrilho = "xl:grid-cols-[272px_1fr_2.75rem]";

const botaoRecolher = () => screen.getByRole("button", { name: "Recolher painel do contato" });
const botaoExpandir = () => screen.getByRole("button", { name: "Expandir painel do contato" });

describe("Inbox — recolher o painel do contato (#3004)", () => {
  it("aberto: o painel desenha o conteúdo e o controle no alto", async () => {
    montar();
    await screen.findByTestId("inbox-demandas");
    expect(screen.queryByTestId("inbox-painel-recolhido")).toBeNull();
    expect(grade().className).toContain(trilhaDaFicha);
    expect(grade().className).not.toContain(trilhaDoTrilho);
    // O controle nomeia o que ele FAZ (recolher), não o estado.
    expect(botaoRecolher()).toBeInTheDocument();
  });

  it("clicar recolhe o painel inteiro: só o trilho fica, e a conversa ganha a largura", async () => {
    const user = userEvent.setup();
    montar();
    await screen.findByTestId("inbox-demandas");

    await user.click(botaoRecolher());

    // O conteúdo do painel sumiu — não é uma seção interna, é o painel todo.
    expect(screen.queryByTestId("inbox-demandas")).toBeNull();
    expect(screen.queryByText("Leads recentes")).toBeNull();
    // E ficou o trilho, com a porta de volta.
    expect(screen.getByTestId("inbox-painel-recolhido")).toBeInTheDocument();
    expect(botaoExpandir()).toBeInTheDocument();
    // A grade devolve a largura: a trilha da ficha vira o trilho estreito.
    await waitFor(() => expect(grade().className).toContain(trilhaDoTrilho));
    expect(grade().className).not.toContain(trilhaDaFicha);
    // E a preferência vai para o servidor — o mesmo caminho do recolher da
    // esquerda (`toggleSidebar`), com o estado ATUAL.
    expect(togglePainelDoContato).toHaveBeenCalledWith(false);
  });

  it("clicar de novo traz o painel de volta, com a ficha na largura de antes", async () => {
    const user = userEvent.setup();
    montar();
    await screen.findByTestId("inbox-demandas");

    await user.click(botaoRecolher());
    await waitFor(() => expect(screen.getByTestId("inbox-painel-recolhido")).toBeInTheDocument());

    await user.click(botaoExpandir());

    // O painel inteiro volta.
    expect(screen.queryByTestId("inbox-painel-recolhido")).toBeNull();
    expect(await screen.findByTestId("inbox-demandas")).toBeInTheDocument();
    await waitFor(() => expect(grade().className).toContain(trilhaDaFicha));
    expect(grade().className).not.toContain(trilhaDoTrilho);
    // Segundo clique: grava o estado ATUAL já recolhido.
    expect(togglePainelDoContato).toHaveBeenLastCalledWith(true);
  });

  it("a preferência do servidor vence na primeira pintura: nasce recolhido", async () => {
    // É o que o cookie `inbox_painel_recolhido`, lido em `app/app/inbox/page.tsx`,
    // entrega ao layout. Sem isto o painel nasceria aberto e pularia para trilho
    // depois da hidratação.
    montar(true);
    expect(await screen.findByTestId("inbox-painel-recolhido")).toBeInTheDocument();
    expect(screen.queryByTestId("inbox-demandas")).toBeNull();
    expect(grade().className).toContain(trilhaDoTrilho);
    // Nada foi gravado só por abrir a tela.
    expect(togglePainelDoContato).not.toHaveBeenCalled();
  });

  it("a divisória da ficha some quando não há ficha para ajustar", async () => {
    const user = userEvent.setup();
    montar();
    await screen.findByTestId("inbox-demandas");
    // Duas alças abertas (lista + ficha).
    expect(screen.getAllByRole("separator")).toHaveLength(2);

    await user.click(botaoRecolher());

    // Recolhido resta só a da lista: a ficha não está na grade.
    expect(screen.getAllByRole("separator")).toHaveLength(1);
  });
  it("recolhido com a divisória ajustada (xl): o estilo inline troca a ficha pelo trilho", async () => {
    // Com largura salva, quem manda é o `style` da grade, não a classe: é o
    // ramo que os casos acima (sem ajuste) não alcançam.
    window.localStorage.setItem("inbox:divisorias:xl", JSON.stringify({ lista: 300, ficha: 320 }));
    montar(true);
    await screen.findByTestId("inbox-painel-recolhido");
    await waitFor(() =>
      expect(grade().style.gridTemplateColumns).toBe("300px minmax(0,1fr) 2.75rem"),
    );
  });

  it("recolhido numa tela sem ficha em coluna (768–1279px): nenhuma trilha vazia à direita", async () => {
    // Entre 768 e 1279px a ficha abre como painel deslizante, não como coluna.
    // O trilho recolhido só existe onde a ficha existe; sem esta guarda a grade
    // ganhava uma terceira trilha de 2.75rem vazia.
    window.innerWidth = 1000;
    try {
      window.localStorage.setItem("inbox:divisorias:md", JSON.stringify({ lista: 320, ficha: 300 }));
      montar(true);
      await waitFor(() => expect(grade().style.gridTemplateColumns).toBe("320px minmax(0,1fr)"));
    } finally {
      window.innerWidth = 1440;
    }
  });
});
