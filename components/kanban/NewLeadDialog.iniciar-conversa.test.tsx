/**
 * "SALVAR E INICIAR CONVERSA" NO CADASTRO DE NEGÓCIO (#3483).
 *
 * ─── O que a issue pedia ────────────────────────────────────────────────────
 *
 * Ao cadastrar um negócio no funil, quem atende ficava no quadro sem caminho
 * para começar a conversa: saía, ia ao Inbox, clicava em "Iniciar conversa" e
 * procurava o contato de novo. O botão novo salva o negócio e cai na conversa
 * do CONTATO dele — pelo caminho do Inbox (`open-with-contact` + `claim`), não
 * por um segundo caminho.
 *
 * ─── O que estes casos prendem ──────────────────────────────────────────────
 *
 *  1. o botão novo cria o negócio, abre a conversa do contato vinculado, pede o
 *     `claim` e navega — nesta ordem;
 *  2. "Criar lead" continua NÃO abrindo conversa nenhuma;
 *  3. negócio SEM contato não oferece o caminho: o botão fica desabilitado e
 *     diz por quê — a thread 1:1 é com uma pessoa, e o funil aceita lead sem
 *     nenhuma (automação e importação criam assim de propósito).
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Stage } from "@/lib/kanban/types";
import type { Lead } from "@/lib/types/leads";
import { DEFAULT_CHANNEL_PROVIDER } from "@/lib/channels";
import { NewLeadDialog } from "@/components/kanban/NewLeadDialog";

const pushMock = vi.hoisted(() => vi.fn());
const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}));
const showApiErrorMock = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useActiveOrg: () => ({ currency: "BRL", country: null, role: "agent", orgId: "org-1" }),
  useAuth: () => ({ user: { id: "usuario-eu" } }),
}));
vi.mock("sonner", () => ({ toast: toastMock }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: showApiErrorMock }));

const FUNIL = "11111111-1111-4111-8111-111111111111";
const ETAPA = "22222222-2222-4222-8222-222222222222";
const CONTATO = "33333333-3333-4333-8333-333333333333";

const STAGE: Stage = {
  id: ETAPA,
  organization_id: "org-1",
  pipeline_id: FUNIL,
  name: "Novo",
  slug: "novo",
  position: 0,
  color: null,
  is_won: false,
  is_lost: false,
  is_archived: false,
  expected_duration_hours: null,
};

const LEAD = {
  id: "44444444-4444-4444-8444-444444444444",
  organization_id: "org-1",
  pipeline_id: FUNIL,
  stage_id: ETAPA,
  contact_id: CONTATO,
  title: "Joana Prado",
  description: null,
  value_cents: null,
  currency: "BRL",
  status: "open",
  source: "manual",
  tags: [],
  custom_fields: {},
  created_at: "2026-09-14T10:00:00.000Z",
  updated_at: "2026-09-14T10:00:00.000Z",
} as unknown as Lead;

function resposta(corpo: unknown, status = 200) {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function rotear(opts: { abertura?: () => Response; erroContato?: boolean; canais?: number } = {}) {
  const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
    const caminho = String(url);
    if (caminho.includes("/api/v1/contacts") && init?.method === "POST") {
      if (opts.erroContato)
        return resposta(
          { error: { code: "validation_failed", message: "Não foi possível criar o contato." } },
          422,
        );
      return resposta(
        {
          data: {
            contact: { id: CONTATO, name: "Joana Prado", phone_number: "+5511987654321" },
            action: "created",
          },
        },
        201,
      );
    }
    if (caminho.includes("/api/v1/channel-sessions"))
      return resposta({
        data: Array.from({ length: opts.canais ?? 0 }, (_, i) => ({
          id: `canal-${i + 1}`,
          display_name: `Canal ${i + 1}`,
          provider: DEFAULT_CHANNEL_PROVIDER,
          status: "WORKING",
          phone_number: `+551198765430${i}`,
          metadata: {},
        })),
      });
    if (caminho.includes("/api/v1/leads")) return resposta({ data: LEAD }, 201);
    if (caminho.includes("/open-with-contact")) {
      return opts.abertura ? opts.abertura() : resposta({ data: { conversation_id: "conv-7" } });
    }
    if (caminho.endsWith("/claim")) return resposta({ data: {} });
    return resposta({ data: [] });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function caminhos(fetchMock: ReturnType<typeof rotear>): string[] {
  return fetchMock.mock.calls
    .map(([url]) => String(url))
    .filter(
      (c) =>
        c.includes("/api/v1/leads") || c.includes("/open-with-contact") || c.endsWith("/claim"),
    );
}

/** O corpo JSON do pedido cujo caminho casa com `trecho`. */
function corpoDo(fetchMock: ReturnType<typeof rotear>, trecho: string): Record<string, unknown> {
  const chamada = fetchMock.mock.calls.find(([url]) => String(url).includes(trecho)) as
    [unknown, RequestInit?] | undefined;
  return JSON.parse(String(chamada?.[1]?.body ?? "{}")) as Record<string, unknown>;
}

function montar(props: { contactId?: string | null } = {}) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  function Pai() {
    const [aberto, setAberto] = useState(true);
    return (
      <NewLeadDialog
        open={aberto}
        onOpenChange={setAberto}
        pipelineId={FUNIL}
        stages={[STAGE]}
        leads={[]}
        {...props}
      />
    );
  }
  const ui: ReactNode = <Pai />;
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  pushMock.mockReset();
  showApiErrorMock.mockReset();
  Object.values(toastMock).forEach((f) => f.mockReset());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("NewLeadDialog · salvar e iniciar conversa (#3483)", () => {
  it.each([1, 2])(
    "o subcadastro devolve o contato sem perder o negócio; só o pai salvo abre a conversa (%i canal/is)",
    async (canais) => {
      const fetchMock = rotear({ canais });
      const user = userEvent.setup();
      montar();
      await user.type(screen.getByLabelText("Título"), "Negócio ainda em edição");
      await user.type(screen.getByLabelText("Descrição"), "Condição combinada com o cliente");
      await user.type(screen.getByLabelText(/^Valor \(/), "123,45");
      await user.click(screen.getByRole("button", { name: "Criar contato" }));
      const cadastro = screen.getByRole("dialog", { name: "Novo contato" });
      expect(
        within(cadastro).queryByRole("button", { name: "Salvar e iniciar conversa" }),
      ).not.toBeInTheDocument();
      await user.type(within(cadastro).getByLabelText(/Telefone/i), "+5511987654321");
      await user.click(
        within(cadastro).getByRole("button", { name: "Criar contato" }),
      );
      await waitFor(() =>
        expect(
          fetchMock.mock.calls.filter(
            ([url, init]) => String(url).includes("/api/v1/contacts") && init?.method === "POST",
          ),
        ).toHaveLength(1),
      );
      expect(
        fetchMock.mock.calls
          .filter(([, init]) => init?.method === "POST")
          .map(([url]) => String(url)),
      ).toEqual(["/api/v1/contacts"]);
      await screen.findByText("Joana Prado");
      expect(screen.queryByRole("dialog", { name: "Novo contato" })).not.toBeInTheDocument();
      expect(screen.getByLabelText("Título")).toHaveValue("Negócio ainda em edição");
      expect(screen.getByLabelText("Descrição")).toHaveValue("Condição combinada com o cliente");
      expect(screen.getByLabelText(/^Valor \(/)).toHaveValue("123,45");
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/v1/leads"))).toBe(
        false,
      );
      expect(pushMock).not.toHaveBeenCalled();
      expect(caminhos(fetchMock)).toEqual([]);
      await user.click(screen.getByRole("button", { name: "Salvar e iniciar conversa" }));
      if (canais === 2) {
        const seletor = await screen.findByRole("dialog", {
          name: "Escolha o canal para iniciar a conversa",
        });
        expect(
          fetchMock.mock.calls.some(([url]) => String(url).includes("/open-with-contact")),
        ).toBe(false);
        await user.click(within(seletor).getByRole("radio", { name: /Canal 2/ }));
        await user.click(
          within(seletor).getByRole("button", { name: "Iniciar conversa" }),
        );
      }
      await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/app/inbox?id=conv-7"));
      expect(
        fetchMock.mock.calls
          .filter(([, init]) => init?.method === "POST")
          .map(([url]) => String(url)),
      ).toEqual([
        "/api/v1/contacts",
        "/api/v1/leads",
        "/api/v1/conversations/open-with-contact",
        "/api/v1/conversations/conv-7/claim",
      ]);
      expect(corpoDo(fetchMock, "/api/v1/leads")).toMatchObject({
        title: "Negócio ainda em edição",
        description: "Condição combinada com o cliente",
        value_cents: 12345,
        contact_id: CONTATO,
      });
      expect(corpoDo(fetchMock, "/open-with-contact")).toMatchObject({
        contact_id: CONTATO,
        channel_session_id: `canal-${canais}`,
      });
    },
  );

  it("a recusa do contato mantém os dois formulários e não grava nem abre o negócio", async () => {
    const fetchMock = rotear({ erroContato: true });
    const user = userEvent.setup();
    montar();
    await user.type(screen.getByLabelText("Título"), "Negócio ainda em edição");
    await user.click(screen.getByRole("button", { name: "Criar contato" }));
    const cadastro = screen.getByRole("dialog", { name: "Novo contato" });
    await user.type(within(cadastro).getByLabelText(/Telefone/i), "+5511987654321");
    await user.click(within(cadastro).getByRole("button", { name: "Criar contato" }));
    await waitFor(() => expect(showApiErrorMock).toHaveBeenCalled());
    expect(
      fetchMock.mock.calls
        .filter(([, init]) => init?.method === "POST")
        .map(([url]) => String(url)),
    ).toEqual(["/api/v1/contacts"]);
    expect(screen.getByRole("dialog", { name: "Novo contato" })).toBeVisible();
    expect(within(cadastro).getByLabelText(/Telefone/i)).toHaveValue("+5511987654321");
    expect(caminhos(fetchMock)).toEqual([]);
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("⭐ cria o negócio, abre a conversa do contato, assume e vai para o Inbox", async () => {
    const fetchMock = rotear();
    const user = userEvent.setup();
    montar({ contactId: CONTATO });

    await user.type(screen.getByLabelText("Título"), "Joana Prado");
    await user.click(screen.getByRole("button", { name: "Salvar e iniciar conversa" }));

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/app/inbox?id=conv-7"));

    // Criar → abrir → assumir. A conversa é a do CONTATO do negócio: é o vínculo
    // que a tela já tem na mão, e inventar outro alvo abriria a thread errada.
    expect(caminhos(fetchMock)).toEqual([
      "/api/v1/leads",
      "/api/v1/conversations/open-with-contact",
      "/api/v1/conversations/conv-7/claim",
    ]);
    expect(corpoDo(fetchMock, "/open-with-contact")).toMatchObject({ contact_id: CONTATO });
    expect(corpoDo(fetchMock, "/claim")).toEqual({ expected_assignee: null });
  });

  it("'Criar lead' continua sem abrir conversa nenhuma", async () => {
    const fetchMock = rotear();
    const user = userEvent.setup();
    montar({ contactId: CONTATO });

    await user.type(screen.getByLabelText("Título"), "Joana Prado");
    await user.click(screen.getByRole("button", { name: "Criar lead" }));

    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith("Lead criado"));
    expect(caminhos(fetchMock)).toEqual(["/api/v1/leads"]);
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("negócio sem contato: o caminho não é oferecido, e o motivo aparece", () => {
    rotear();
    montar();

    const botao = screen.getByRole("button", { name: "Salvar e iniciar conversa" });
    expect(botao).toBeDisabled();
    expect(botao).toHaveAttribute("title", "Escolha um contato para abrir a conversa.");
  });

  it("recusa do servidor (sem papel) aparece e NÃO navega", async () => {
    rotear({
      abertura: () => resposta({ error: { code: "forbidden", message: "Sem permissão." } }, 403),
    });
    const user = userEvent.setup();
    montar({ contactId: CONTATO });

    await user.type(screen.getByLabelText("Título"), "Joana Prado");
    await user.click(screen.getByRole("button", { name: "Salvar e iniciar conversa" }));

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith("Sem permissão."));
    // O negócio JÁ foi criado (a recusa é do passo seguinte) e nada é assumido:
    // o caminho novo herda a recusa do Inbox em vez de contorná-la.
    expect(toastMock.success).toHaveBeenCalledWith("Lead criado");
    expect(pushMock).not.toHaveBeenCalled();
  });
});
