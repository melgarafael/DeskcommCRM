import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O seletor de canal ao INICIAR uma conversa nova (issue #2382).
 *
 * ─── O que os quatro casos prendem ──────────────────────────────────────────
 *
 * 1. Multi-canal: com dois canais elegíveis o diálogo aparece ANTES de criar
 *    qualquer coisa, cada opção mostra as QUATRO coisas que a issue pediu
 *    (nome amigável, número, tipo/provedor e estado), e a conversa nasce
 *    amarrada ao canal escolhido — `channel_session_id` no corpo do POST.
 * 2. Canal único: um só canal elegível não obriga ninguém a escolher — o fluxo
 *    segue direto, e o canal já vem gravado na conversa.
 * 3. Desativado e indisponível: o canal que o operador desligou NEM aparece, e
 *    o que está fora do ar aparece com o estado e desmarcado — os dois
 *    critérios "não podem ser escolhidos", um por porta.
 * 4. Zero elegíveis: sem canal utilizável o fluxo NÃO trava (a lista fica
 *    vazia, o POST sai sem escolha e o servidor decide, como antes).
 * 5. Rede social: canal sem telefone (Instagram/Messenger) não inicia conversa
 *    com um contato de telefone, então não conta como opção — com ele e um
 *    número conectado, o fluxo segue direto pelo número.
 *
 * A lista vem de `GET /api/v1/channel-sessions` (a mesma fonte do seletor do
 * inbox), então o teste mocka `apiClient.get` em vez de trocar o hook: as
 * peneiras de `lib/channels/conversa-nova.ts` entram na conta.
 */
const getMock = vi.hoisted(() => vi.fn());
const aoAbrirMock = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: getMock,
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    del: vi.fn(),
    delete: vi.fn(),
  },
}));
vi.mock("sonner", () => ({
  toast: { error: toastError, success: vi.fn(), info: vi.fn() },
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));

import type { ChannelSession } from "@/hooks/channels/useChannelSessions";
import { useConversaNovaComEscolhaDeCanal } from "@/components/channels/SeletorDeCanalParaConversa";

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

/** O mínimo que a tela de contatos faz depois de abrir: navegar para o inbox. */
function Painel() {
  const { iniciarConversa, seletor } = useConversaNovaComEscolhaDeCanal({
    aoAbrir: aoAbrirMock,
  });
  return (
    <div>
      <button
        type="button"
        onClick={() =>
          void iniciarConversa({ contact_id: "contato-1", phone_number: "+5517999998888" })
        }
      >
        iniciar
      </button>
      {seletor}
    </div>
  );
}

function montar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Painel />
    </QueryClientProvider>,
  );
}

function corpoDoPost(): Record<string, unknown> {
  const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
}

beforeEach(() => {
  getMock.mockReset();
  aoAbrirMock.mockReset();
  toastError.mockReset();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ data: { conversation_id: "conv-9" } }),
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Seletor de canal ao iniciar conversa nova (#2382)", () => {
  it("dois canais elegíveis: escolhe ANTES de criar, com nome, número, tipo e estado", async () => {
    getMock.mockResolvedValue({
      data: [
        canal({ id: "canal-pecas", display_name: "Peças", phone_number: "+5517999990001" }),
        canal({
          id: "canal-vendas",
          display_name: "Vendas",
          phone_number: "+5517999990002",
          provider: "meta_cloud",
        }),
      ],
    });
    montar();

    fireEvent.click(screen.getByRole("button", { name: "iniciar" }));

    const dialogo = await screen.findByRole("dialog");
    expect(dialogo).toHaveTextContent("Escolha o canal para iniciar a conversa");

    // Nome, número e tipo de cada opção — e não só o provider.
    const pecas = screen.getByRole("radio", { name: /Peças/ });
    const vendas = screen.getByRole("radio", { name: /Vendas/ });
    expect(pecas).toBeInTheDocument();
    expect(vendas).toBeInTheDocument();
    expect(screen.getByText("WAHA (QR Code)")).toBeInTheDocument();
    expect(screen.getByText("Meta Cloud API")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /999990001/ })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /999990002/ })).toBeInTheDocument();
    // Estado de cada canal, na própria opção.
    expect(screen.getAllByText("Conectado")).toHaveLength(2);

    // Nada foi criado ainda: o seletor vem ANTES da conversa.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(aoAbrirMock).not.toHaveBeenCalled();

    fireEvent.click(vendas);
    fireEvent.click(screen.getByRole("button", { name: "Iniciar conversa" }));

    await waitFor(() => expect(aoAbrirMock).toHaveBeenCalledWith("conv-9"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(corpoDoPost()).toEqual({
      contact_id: "contato-1",
      phone_number: "+5517999998888",
      channel_session_id: "canal-vendas",
    });
    expect(toastError).not.toHaveBeenCalled();
  });

  it("um único canal elegível: segue direto, já com aquele canal gravado", async () => {
    getMock.mockResolvedValue({
      data: [canal({ id: "canal-unico", display_name: "Peças", phone_number: "+5517999990001" })],
    });
    montar();

    fireEvent.click(screen.getByRole("button", { name: "iniciar" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(corpoDoPost()).toEqual({
      contact_id: "contato-1",
      phone_number: "+5517999998888",
      channel_session_id: "canal-unico",
    });
    await waitFor(() => expect(aoAbrirMock).toHaveBeenCalledWith("conv-9"));
  });

  it("canal desativado não aparece e o canal fora do ar aparece sem poder ser escolhido", async () => {
    getMock.mockResolvedValue({
      data: [
        canal({ id: "canal-a", display_name: "Peças", phone_number: "+5517999990001" }),
        canal({
          id: "canal-b",
          display_name: "Vendas",
          phone_number: "+5517999990002",
          provider: "meta_cloud",
        }),
        // Desligado pelo operador (#2318): nem entra na lista.
        canal({
          id: "canal-desligado",
          display_name: "Peças antigo",
          phone_number: "+5517999990003",
          metadata: { disabled: true },
        }),
        // Fora do ar: entra, com o estado, mas não pode ser escolhido.
        canal({
          id: "canal-caido",
          display_name: "Vendas caído",
          phone_number: "+5517999990004",
          status: "FAILED",
        }),
      ],
    });
    montar();

    fireEvent.click(screen.getByRole("button", { name: "iniciar" }));
    await screen.findByRole("dialog");

    expect(screen.queryByRole("radio", { name: /Peças antigo/ })).toBeNull();
    expect(screen.getAllByRole("radio")).toHaveLength(3);

    const caido = screen.getByRole("radio", { name: /Vendas caído/ });
    expect(caido).toBeDisabled();
    // O estado está na OPÇÃO (o `<label>` em volta), que é o que quem lê vê.
    expect(caido.closest("label")).toHaveTextContent("Caiu");

    // O que sobrou é escolhível, e o diálogo não deixa confirmar sem escolha.
    expect(screen.getByRole("radio", { name: /Peças/ })).not.toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("canal de rede social (sem telefone) não é opção: segue direto pelo número", async () => {
    getMock.mockResolvedValue({
      data: [
        canal({ id: "canal-numero", display_name: "Peças", phone_number: "+5517999990001" }),
        canal({ id: "canal-social", display_name: "Instagram", provider: "zernio_social" }),
      ],
    });
    montar();

    fireEvent.click(screen.getByRole("button", { name: "iniciar" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(corpoDoPost()).toEqual({
      contact_id: "contato-1",
      phone_number: "+5517999998888",
      channel_session_id: "canal-numero",
    });
    await waitFor(() => expect(aoAbrirMock).toHaveBeenCalledWith("conv-9"));
  });

  it("nenhum canal elegível: o fluxo não trava — segue sem escolha", async () => {
    getMock.mockResolvedValue({
      // Com telefone: o que tira este canal da escolha é o ESTADO, não a
      // peneira do telefone — senão o caso deixaria de vigiar a régua de status.
      data: [
        canal({
          id: "canal-caido",
          display_name: "Vendas",
          phone_number: "+5517999990001",
          status: "STOPPED",
        }),
      ],
    });
    montar();

    fireEvent.click(screen.getByRole("button", { name: "iniciar" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog")).toBeNull();
    // Sem escolha, o corpo é o de sempre: o servidor decide o canal.
    expect(corpoDoPost()).toEqual({
      contact_id: "contato-1",
      phone_number: "+5517999998888",
    });
    await waitFor(() => expect(aoAbrirMock).toHaveBeenCalledWith("conv-9"));
    expect(toastError).not.toHaveBeenCalled();
  });
});
