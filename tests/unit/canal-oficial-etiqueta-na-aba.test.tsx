/**
 * A aba "Números por QR" ETIQUETA o canal oficial — e continua listando todos.
 *
 * ─── As duas metades da fatia F6 da #850 ────────────────────────────────────
 *
 * A aba lista os canais de mensagem da organização, e o oficial (API da Meta)
 * caiu nessa lista junto com os pareados por QR sem nada que os distinguisse:
 * sem etiqueta e sem filtro, quem opera não tem como saber que aquele número
 * não tem QR para reescanear nem aparelho para deslogar.
 *
 * A decisão foi NÃO filtrar — esconder canal da tela de conexões é o tipo de
 * silêncio que faz alguém parear de novo um número que já existe — e marcar o
 * oficial com uma etiqueta. Por isso metade dos casos prova o rótulo e a outra
 * metade prova que NADA saiu da lista: um filtro acidental aqui passaria
 * despercebido, porque o canal que some é justamente o que estes casos existem
 * para mostrar.
 *
 * ─── Por que a etiqueta não sai de `waha_session_name` ──────────────────────
 *
 * A tela já pergunta "depende do transporte?" para decidir o Reconectar, e a
 * resposta seria conveniente aqui (o canal oficial não tem nome de sessão).
 * Ela responde OUTRA pergunta: um número por QR recém-criado, ainda sem nome de
 * sessão, ganharia a etiqueta de oficial — afirmação falsa na cara de quem
 * opera. O último caso abaixo é exatamente esse número.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import {
  CHANNEL_PROVIDER_META,
  CHANNEL_PROVIDER_WAHA,
  CHANNEL_PROVIDER_ZERNIO,
} from "@/lib/channels/capabilities";
import type * as CanaisModule from "@/hooks/channels/useChannelSessions";
import type { ChannelSession } from "@/hooks/channels/useChannelSessions";

const getMock = vi.fn();
const postMock = vi.fn();
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: (...a: unknown[]) => getMock(...a),
    post: (...a: unknown[]) => postMock(...a),
    delete: vi.fn(),
  },
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@/hooks/channels/usePacingKnobs", () => ({
  usePacingKnobs: () => ({ data: { items: [] } }),
}));

vi.mock("@/components/connections/AntiBanSheet", () => ({ AntiBanSheet: () => null }));

const listagem: {
  data: ChannelSession[] | undefined;
  isLoading: boolean;
  isError: boolean;
  schemaOutdated: boolean;
} = { data: [], isLoading: false, isError: false, schemaOutdated: false };

// Só a listagem é dublada: `channelLabel` do módulo real é o que nomeia os
// cartões, e é por ele que os casos abaixo encontram cada canal na tela.
vi.mock("@/hooks/channels/useChannelSessions", async (original) => {
  const real = await original<typeof CanaisModule>();
  return { ...real, useChannelSessions: () => listagem };
});

import { ConnectionsClient } from "@/components/connections/ConnectionsClient";

const ETIQUETA = "API oficial";

function canal(over: Partial<ChannelSession> = {}): ChannelSession {
  return {
    id: "canal-1",
    provider: CHANNEL_PROVIDER_WAHA,
    waha_session_name: "org_1111_aaa",
    display_name: "Vendas",
    phone_number: "5511999999999",
    status: "WORKING",
    status_reason: null,
    last_health_check_at: null,
    last_status_change_at: null,
    daily_message_limit: 250,
    is_warmup_complete: null,
    created_at: "2026-08-01T00:00:00Z",
    ...over,
  };
}

/** O canal oficial: sem sessão no transporte, revogado por credencial. */
const oficial = canal({
  id: "oficial-1",
  provider: CHANNEL_PROVIDER_META,
  waha_session_name: null,
  display_name: "Atendimento oficial",
});

const porQr = canal({ id: "qr-1", display_name: "Vendas" });

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
  listagem.data = [oficial];
  listagem.isLoading = false;
  listagem.isError = false;
  listagem.schemaOutdated = false;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("o canal oficial na lista de números", () => {
  it("traz a etiqueta de API oficial ao lado do nome", () => {
    render(wrap(<ConnectionsClient wahaConfigured />));

    expect(screen.getByText("Atendimento oficial")).toBeInTheDocument();
    expect(screen.getByText(ETIQUETA)).toBeInTheDocument();
  });

  it("a etiqueta não substitui o estado da conexão — os dois badges convivem", () => {
    render(wrap(<ConnectionsClient wahaConfigured />));

    expect(screen.getByText(ETIQUETA)).toBeInTheDocument();
    expect(screen.getByText("Conectado")).toBeInTheDocument();
  });

  it("o canal de QR não recebe a etiqueta", () => {
    listagem.data = [porQr];

    render(wrap(<ConnectionsClient wahaConfigured />));

    expect(screen.getByText("Vendas")).toBeInTheDocument();
    expect(screen.queryByText(ETIQUETA)).not.toBeInTheDocument();
  });

  it("o canal de provedor parceiro também não: oficial é um só", () => {
    listagem.data = [canal({ id: "parceiro-1", provider: CHANNEL_PROVIDER_ZERNIO, display_name: "Parceiro" })];

    render(wrap(<ConnectionsClient wahaConfigured />));

    expect(screen.getByText("Parceiro")).toBeInTheDocument();
    expect(screen.queryByText(ETIQUETA)).not.toBeInTheDocument();
  });

  it("número por QR recém-criado, ainda sem nome de sessão, não vira oficial", () => {
    // É o caso que separa esta etiqueta do botão Reconectar: sem sessão no
    // transporte não é sinônimo de canal oficial.
    listagem.data = [
      canal({ id: "qr-novo", display_name: null, phone_number: null, waha_session_name: null, status: "STARTING" }),
    ];

    render(wrap(<ConnectionsClient wahaConfigured />));

    expect(screen.getByText("Número sem nome")).toBeInTheDocument();
    expect(screen.queryByText(ETIQUETA)).not.toBeInTheDocument();
  });
});

describe("a lista não esconde canal nenhum", () => {
  it("mostra o oficial e o número por QR na mesma lista, com uma etiqueta só", () => {
    listagem.data = [oficial, porQr];

    render(wrap(<ConnectionsClient wahaConfigured />));

    expect(screen.getByText("Atendimento oficial")).toBeInTheDocument();
    expect(screen.getByText("Vendas")).toBeInTheDocument();
    expect(screen.getAllByText(ETIQUETA)).toHaveLength(1);
  });

  it("o canal oficial continua na lista mesmo sem o serviço de WhatsApp configurado", () => {
    // A aba é a única porta para ver e excluir o canal oficial quando o
    // transporte nem está no ar — filtrá-lo aqui o deixaria inalcançável.
    listagem.data = [oficial, porQr];

    render(wrap(<ConnectionsClient wahaConfigured={false} />));

    expect(screen.getByText("Atendimento oficial")).toBeInTheDocument();
    expect(screen.getByText(ETIQUETA)).toBeInTheDocument();
  });
});
