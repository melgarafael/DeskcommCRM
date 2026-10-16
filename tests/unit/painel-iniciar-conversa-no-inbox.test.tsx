import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O painel "Iniciar conversa" do Inbox (issue #2813).
 *
 * ─── Os quatro passos, e o que cada caso prende ─────────────────────────────
 *
 * 1. PARA QUEM. Telefone novo em formato brasileiro entra, sai normalizado em
 *    E.164 e o POST o leva para a rota de abertura — a conversa nasce amarrada
 *    ao canal escolhido.
 * 2. CONTATO EXISTENTE. Quando o número digitado já é de alguém da base, o
 *    painel manda `contact_id` e NÃO manda `phone_number`: reusa a ficha, em
 *    vez de deixar a rota criar (ou sobrescrever) um contato por telefone.
 * 3. CANAL. A lista é a mesma do fluxo da tabela de Contatos
 *    (`SeletorDeCanalParaConversa`); canal sem telefone (rede social) não inicia
 *    conversa e por isso não é opção.
 * 4. ATRIBUIÇÃO. Abrir conversa por aqui NÃO é abrir conversa para a IA: o
 *    painel chama `POST /conversations/[id]/claim` com `expected_assignee:
 *    null` — o dono passa a ser quem iniciou, e o silêncio do bot é gravado na
 *    mesma transação. A primeira mensagem sai DEPOIS disso.
 *
 * A lista de canais vem de `GET /api/v1/channel-sessions` (a mesma fonte do
 * seletor do inbox) e a busca de contatos de `GET /api/v1/contacts`; as duas
 * passam pelo `apiClient`, então o teste mocka o CLIENTE e deixa as peneiras de
 * `lib/channels/conversa-nova.ts` entrarem na conta. O POST de abrir conversa é
 * `fetch` puro dentro do componente reusado — é o `fetch` global que se stuba.
 */
const getMock = vi.hoisted(() => vi.fn());
const postMock = vi.hoisted(() => vi.fn());
const pushMock = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
const podeMock = vi.hoisted(() => vi.fn(() => true));
const toastInfo = vi.hoisted(() => vi.fn());
const showApiErrorMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: getMock,
    post: postMock,
    put: vi.fn(),
    patch: vi.fn(),
    del: vi.fn(),
    delete: vi.fn(),
  },
}));
vi.mock("sonner", () => ({
  toast: { error: toastError, success: vi.fn(), info: toastInfo },
}));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: showApiErrorMock }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  usePermission: () => podeMock(),
  useAuth: () => ({ user: { id: "eu" } }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn(), refresh: vi.fn() }),
}));

import type { ChannelSession } from "@/hooks/channels/useChannelSessions";
import { BotaoIniciarConversa } from "@/components/inbox/PainelIniciarConversa";
import { ApiError } from "@/lib/api/types";

const fetchMock = vi.fn();

/** Uma linha de `channel_sessions` já no formato que a rota devolve. */
function canal(overrides: Partial<ChannelSession> & { id: string }): ChannelSession {
  return {
    provider: "waha",
    waha_session_name: `sessao-${overrides.id}`,
    display_name: null,
    phone_number: null,
    status: "WORKING",
    status_reason: null,
    last_health_check_at: null,
    last_status_change_at: null,
    daily_message_limit: 0,
    is_warmup_complete: true,
    metadata: {},
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** O mínimo de contato que a busca devolve e o painel lê. */
function contato(overrides: { id: string; phone_number?: string | null; name?: string | null }) {
  return {
    id: overrides.id,
    name: overrides.name ?? null,
    display_name: null,
    phone_number: overrides.phone_number ?? null,
    email: null,
    is_anonymized: false,
    created_at: "2026-01-01T00:00:00.000Z",
  };
}

/** As duas leituras do painel, roteadas por caminho. */
function lerCanaisE(canais: ChannelSession[], contatos: ReturnType<typeof contato>[]) {
  getMock.mockImplementation(async (caminho: string) => {
    if (caminho.startsWith("/api/v1/channel-sessions")) return { data: canais };
    if (caminho.startsWith("/api/v1/contacts")) return { data: contatos, meta: {} };
    if (caminho.startsWith("/api/v1/message-templates")) return { data: [] };
    return { data: [] };
  });
}

function montar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BotaoIniciarConversa />
    </QueryClientProvider>,
  );
}

/** Abre o painel e digita o telefone — o começo de todo caso. */
async function abrirComTelefone(telefone: string) {
  montar();
  fireEvent.click(screen.getByRole("button", { name: "Iniciar conversa" }));
  const campo = await screen.findByLabelText("Para quem");
  fireEvent.change(campo, { target: { value: telefone } });
  return campo;
}

function corpoDoPost(indice = 0): Record<string, unknown> {
  const init = fetchMock.mock.calls[indice]?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
}

function cliquesDoPost(): Array<[string, unknown]> {
  return postMock.mock.calls as unknown as Array<[string, unknown]>;
}

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
  pushMock.mockReset();
  toastError.mockReset();
  toastInfo.mockReset();
  showApiErrorMock.mockReset();
  podeMock.mockReset();
  podeMock.mockReturnValue(true);
  fetchMock.mockReset();
  postMock.mockResolvedValue({ data: {} });
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ data: { conversation_id: "conv-9" } }),
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Painel Iniciar conversa no Inbox (#2813)", () => {
  it("passo 1: telefone novo em formato brasileiro vira E.164, cria o contato e abre a conversa", async () => {
    lerCanaisE([canal({ id: "canal-numero", display_name: "Peças", phone_number: "+5511999990001" })], []);

    await abrirComTelefone("(11) 99999-0001");

    // O painel confirma que é contato NOVO, e já mostra o número normalizado.
    expect(screen.getByText(/Novo contato/)).toHaveTextContent("+5511999990001");

    fireEvent.click(screen.getByRole("button", { name: "Criar conversa" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(corpoDoPost()).toEqual({
      phone_number: "+5511999990001",
      channel_session_id: "canal-numero",
    });
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/app/inbox?id=conv-9"));
    expect(toastError).not.toHaveBeenCalled();
  });

  it("passo 2: telefone que já é de um contato REUSA a ficha — manda contact_id e não phone_number", async () => {
    lerCanaisE(
      [canal({ id: "canal-numero", display_name: "Peças", phone_number: "+5511999990001" })],
      [contato({ id: "contato-ana", name: "Ana Souza", phone_number: "+5511999990001" })],
    );

    await abrirComTelefone("(11) 99999-0001");

    // A busca encontra a ficha; o painel avisa que vai usá-la.
    await waitFor(() => expect(screen.getByText(/Contato existente/)).toHaveTextContent("Ana Souza"));

    fireEvent.click(screen.getByRole("button", { name: "Criar conversa" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(corpoDoPost()).toEqual({
      contact_id: "contato-ana",
      channel_session_id: "canal-numero",
    });
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/app/inbox?id=conv-9"));
  });

  it("passo 3: dois números conectados pedem a escolha, e o canal social não é opção", async () => {
    lerCanaisE(
      [
        canal({ id: "canal-pecas", display_name: "Peças", phone_number: "+5511999990001" }),
        canal({ id: "canal-vendas", display_name: "Vendas", phone_number: "+5511999990002" }),
        canal({ id: "canal-social", display_name: "Instagram", provider: "zernio_social" }),
      ],
      [],
    );

    await abrirComTelefone("(11) 99999-0001");
    fireEvent.click(screen.getByRole("button", { name: "Criar conversa" }));

    // Nada foi criado antes de escolher o canal.
    const titulo = await screen.findByText("Escolha o canal para iniciar a conversa");
    const seletor = titulo.closest('[role="dialog"]') as HTMLElement;
    expect(fetchMock).not.toHaveBeenCalled();

    expect(within(seletor).queryByRole("radio", { name: /Instagram/ })).toBeNull();
    expect(within(seletor).getAllByRole("radio")).toHaveLength(2);

    fireEvent.click(within(seletor).getByRole("radio", { name: /Vendas/ }));
    fireEvent.click(within(seletor).getByRole("button", { name: "Iniciar conversa" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(corpoDoPost()).toEqual({
      phone_number: "+5511999990001",
      channel_session_id: "canal-vendas",
    });
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/app/inbox?id=conv-9"));
  });

  it("passo 4: a IA não assume — a conversa é atribuída a quem iniciou antes de a mensagem sair", async () => {
    lerCanaisE([canal({ id: "canal-numero", display_name: "Peças", phone_number: "+5511999990001" })], []);

    await abrirComTelefone("(11) 99999-0001");
    fireEvent.change(screen.getByLabelText("Primeira mensagem"), {
      target: { value: "Bom dia! Podemos falar?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Criar conversa" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // Primeiro o dono (e o silêncio do bot, na mesma transação do servidor)...
    await waitFor(() =>
      expect(cliquesDoPost()[0]).toEqual([
        "/api/v1/conversations/conv-9/claim",
        { expected_assignee: null },
      ]),
    );
    // ...e só então a mensagem escrita por quem iniciou.
    await waitFor(() =>
      expect(cliquesDoPost()[1]).toEqual([
        "/api/v1/messages",
        { conversation_id: "conv-9", body: "Bom dia! Podemos falar?" },
      ]),
    );
    expect(cliquesDoPost()).toHaveLength(2);
    expect(pushMock).toHaveBeenCalledWith("/app/inbox?id=conv-9");
  });

  it("claim recusado por outro motivo que não 409: a primeira mensagem NÃO sai e o erro aparece", async () => {
    lerCanaisE([canal({ id: "canal-numero", display_name: "Peças", phone_number: "+5511999990001" })], []);
    const recusa = new ApiError(500, "internal_error", undefined, "req-1");
    postMock.mockImplementation(async (caminho: string) => {
      if (caminho.endsWith("/claim")) throw recusa;
      return { data: {} };
    });

    await abrirComTelefone("(11) 99999-0001");
    fireEvent.change(screen.getByLabelText("Primeira mensagem"), { target: { value: "Oi" } });
    fireEvent.click(screen.getByRole("button", { name: "Criar conversa" }));

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/app/inbox?id=conv-9"));
    expect(showApiErrorMock).toHaveBeenCalledWith(recusa);
    expect(cliquesDoPost().map(([caminho]) => caminho)).toEqual(["/api/v1/conversations/conv-9/claim"]);
  });

  it("409 com a conversa de OUTRO atendente: a primeira mensagem não sai e o dono é nomeado", async () => {
    lerCanaisE([canal({ id: "canal-numero", display_name: "Peças", phone_number: "+5511999990001" })], []);
    const conflito = new ApiError(409, "state_conflict", undefined, "req-2");
    postMock.mockImplementation(async (caminho: string) => {
      if (caminho.endsWith("/claim")) throw conflito;
      return { data: {} };
    });
    const leituraDeCanais = getMock.getMockImplementation();
    getMock.mockImplementation(async (caminho: string) => {
      if (caminho === "/api/v1/conversations/conv-9") {
        return { data: { assigned_to_user_id: "outra", assigned_to_user_name: "Ana" } };
      }
      return leituraDeCanais?.(caminho);
    });

    await abrirComTelefone("(11) 99999-0001");
    fireEvent.change(screen.getByLabelText("Primeira mensagem"), { target: { value: "Oi" } });
    fireEvent.click(screen.getByRole("button", { name: "Criar conversa" }));

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/app/inbox?id=conv-9"));
    expect(toastInfo).toHaveBeenCalledWith("A conversa neste número está com Ana.");
    expect(showApiErrorMock).not.toHaveBeenCalled();
    expect(cliquesDoPost().map(([caminho]) => caminho)).toEqual(["/api/v1/conversations/conv-9/claim"]);
  });

  it("o seletor de modelo nasce mostrando o que ele faz, e não uma caixa vazia", async () => {
    lerCanaisE([canal({ id: "canal-numero", display_name: "Peças", phone_number: "+5511999990001" })], []);
    const leitura = getMock.getMockImplementation();
    getMock.mockImplementation(async (caminho: string) => {
      if (caminho.startsWith("/api/v1/message-templates")) {
        return {
          data: [{ id: "m1", title: "Boas-vindas", body: "Oi!", shortcut: null, owner_user_id: null }],
        };
      }
      return leitura?.(caminho);
    });

    await abrirComTelefone("(11) 99999-0001");

    // O rótulo precisa estar ESCRITO no gatilho, não só no aria-label: um valor
    // inicial que não é opção faz o Radix esconder o placeholder.
    const gatilho = await screen.findByRole("combobox", { name: "Usar modelo de mensagem" });
    expect(gatilho).toHaveTextContent("Usar modelo de mensagem");
  });

  it("quem não pode atender não vê o botão", () => {
    podeMock.mockReturnValue(false);
    lerCanaisE([], []);
    montar();

    expect(screen.queryByRole("button", { name: "Iniciar conversa" })).toBeNull();
  });
});
