/**
 * Issue #669 — "Proteção de envio" abria depois de mexer nos canais sem os
 * dados (cache velho) e, quando a conexão pedida já não estava na lista, o
 * botão morria mudo.
 *
 * Prova 1 (comportamento): TODOS os caminhos que mexem nos canais — criar,
 * excluir, reconectar e o health check — passam pelo MESMO `invalidate` do
 * ConnectionsClient. Este teste dispara o funil pelo health check inicial e
 * exige, com spy no queryClient, as DUAS chaves: `channel-sessions` (a lista)
 * e `pacing-knobs` (a ficha que o painel lê). Sem a segunda, vermelho.
 *
 * Prova 2 (comportamento): com item nulo — conexão excluída em outra
 * aba/máquina, lista velha — o AntiBanSheet mostra estado visível (mensagem
 * honesta + "Tentar de novo", que invalida `pacing-knobs`, + "Fechar") em vez
 * de sumir; quando a lista volta com a conexão, o formulário hidrata.
 * Controle: com o item presente, o painel normal aparece e o aviso não.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import type * as CanaisModule from "@/hooks/channels/useChannelSessions";
import type { ChannelSession } from "@/hooks/channels/useChannelSessions";
import type { PacingKnobs } from "@/lib/agent-engine/pacing/defaults";
import type { PacingKnobsItem } from "@/hooks/channels/usePacingKnobs";

const getMock = vi.fn();
const postMock = vi.fn();
const deleteMock = vi.fn();
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: (...a: unknown[]) => getMock(...a),
    post: (...a: unknown[]) => postMock(...a),
    delete: (...a: unknown[]) => deleteMock(...a),
  },
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// A lista de pacing é dublada de propósito — o teste escolhe o que o painel vê
// ("lista velha" = sem a conexão) e o funil de invalidação continua observável
// pelo spy no queryClient, que é a asserção.
const pacing = vi.hoisted(() => ({ lista: [] as PacingKnobsItem[], update: vi.fn() }));
vi.mock("@/hooks/channels/usePacingKnobs", () => ({
  usePacingKnobs: () => ({ data: { items: pacing.lista } }),
  useUpdatePacingKnobs: () => ({ mutateAsync: pacing.update, isPending: false }),
}));

const listagem: {
  data: ChannelSession[] | undefined;
  isLoading: boolean;
  isError: boolean;
  schemaOutdated: boolean;
} = { data: [], isLoading: false, isError: false, schemaOutdated: false };

// Só a listagem é dublada: `channelLabel`/`deriveOverallHealth` reais são o que
// os cartões mostram (mesmo molde de conexoes-excluir-canal.test.tsx).
vi.mock("@/hooks/channels/useChannelSessions", async (original) => {
  const real = await original<typeof CanaisModule>();
  return { ...real, useChannelSessions: () => listagem };
});

import { ConnectionsClient } from "@/components/connections/ConnectionsClient";
import { AntiBanSheet } from "@/components/connections/AntiBanSheet";

function canal(over: Partial<ChannelSession> = {}): ChannelSession {
  return {
    id: "canal-1",
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

const KNOBS: PacingKnobs = {
  throttleMs: 1_200,
  jitterMaxMs: 800,
  windowStartHour: 7,
  windowEndHour: 22,
  allowSunday: true,
  timezone: "America/Sao_Paulo",
  warmupDailyCaps: [
    { minAgeDays: 0, cap: 20 },
    { minAgeDays: 7, cap: 60 },
    { minAgeDays: 30, cap: null },
  ],
};

function itemDePacing(over: Partial<PacingKnobsItem> = {}): PacingKnobsItem {
  return {
    channel_session: {
      id: "canal-1",
      waha_session_name: "org_1111_aaa",
      display_name: "Vendas",
      phone_number: "5511999999999",
      status: "WORKING",
      daily_message_limit: 250,
    },
    effective: KNOBS,
    warmup: { number_activated_at: null, age_days: 0, skipped: false, cap_today: 20 },
    overrides: null,
    defaults: KNOBS,
    bounds: {
      intervalMaxMs: 600_000,
      hourLastStart: 23,
      hourEnd: 24,
      daily_limit: { min: 1, max: 2_000 },
    },
    ...over,
  };
}

function novoCliente() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function wrap(ui: ReactNode, qc: QueryClient = novoCliente()) {
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
  deleteMock.mockReset();
  pacing.lista = [];
  pacing.update.mockReset();
  listagem.data = [];
  listagem.isLoading = false;
  listagem.isError = false;
  listagem.schemaOutdated = false;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("#669 — mexer nos canais invalida AS DUAS listas", () => {
  it("o funil único (por onde passam criar/excluir/reconectar/health check) invalida channel-sessions e pacing-knobs", async () => {
    listagem.data = [canal()];
    const qc = novoCliente();
    const invalidar = vi.spyOn(qc, "invalidateQueries");

    render(wrap(<ConnectionsClient wahaConfigured />, qc));

    await waitFor(() =>
      expect(invalidar).toHaveBeenCalledWith({ queryKey: ["pacing-knobs"] }),
    );
    expect(invalidar).toHaveBeenCalledWith({ queryKey: ["channel-sessions"] });
  });
});

describe("#669 — painel não morre mudo quando a conexão sumiu da lista", () => {
  it("com item nulo o painel abre com aviso honesto e as duas saídas, não em branco", () => {
    render(wrap(<AntiBanSheet item={null} canWrite onClose={vi.fn()} />));

    expect(screen.getByTestId("anti-ban-indisponivel")).toHaveTextContent(
      /pode ter sido removida/,
    );
    expect(screen.getByRole("button", { name: "Tentar de novo" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Fechar" })).toBeInTheDocument();
    expect(screen.queryByTestId("anti-ban-form")).toBeNull();
  });

  it("'Tentar de novo' invalida pacing-knobs; 'Fechar' fecha", async () => {
    const qc = novoCliente();
    const invalidar = vi.spyOn(qc, "invalidateQueries");
    const onClose = vi.fn();

    render(wrap(<AntiBanSheet item={null} canWrite onClose={onClose} />, qc));

    fireEvent.click(screen.getByTestId("anti-ban-tentar-de-novo"));
    await waitFor(() =>
      expect(invalidar).toHaveBeenCalledWith({ queryKey: ["pacing-knobs"] }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Fechar" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("quando a lista volta com a conexão, o formulário hidrata e o painel normal assume", async () => {
    const qc = novoCliente();
    const onClose = vi.fn();
    const { rerender } = render(
      wrap(<AntiBanSheet item={null} canWrite onClose={onClose} />, qc),
    );
    expect(screen.queryByTestId("anti-ban-form")).toBeNull();

    rerender(wrap(<AntiBanSheet item={itemDePacing()} canWrite onClose={onClose} />, qc));

    expect(await screen.findByTestId("anti-ban-form")).toBeInTheDocument();
    expect(screen.queryByTestId("anti-ban-indisponivel")).toBeNull();
  });

  it("controle: com a conexão na lista, o painel normal aparece e o aviso NÃO", async () => {
    render(wrap(<AntiBanSheet item={itemDePacing()} canWrite onClose={vi.fn()} />));

    expect(await screen.findByTestId("anti-ban-form")).toBeInTheDocument();
    expect(screen.getByText(/Proteção de envio —/)).toBeInTheDocument();
    expect(screen.queryByTestId("anti-ban-indisponivel")).toBeNull();
  });

  it("ponta a ponta: clicar em 'Proteção de envio' com a lista velha mostra o aviso, não o silêncio", async () => {
    listagem.data = [canal()];
    pacing.lista = []; // lista velha: a conexão existe, a ficha de pacing não chegou

    render(wrap(<ConnectionsClient wahaConfigured />));

    // Antes de abrir, nada de painel fantasma (o Sheet só monta quando pedido).
    expect(screen.queryByTestId("anti-ban-indisponivel")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Proteção de envio/ }));

    expect(await screen.findByTestId("anti-ban-indisponivel")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tentar de novo" })).toBeInTheDocument();
  });
});
