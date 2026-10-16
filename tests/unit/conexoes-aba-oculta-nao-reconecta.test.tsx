/**
 * Central de Conexões — a aba OCULTA não pergunta o status da sessão (refs #2821).
 *
 * O diálogo de pareamento pergunta o estado da sessão a cada 3 s enquanto o
 * fluxo de conexão está em andamento — é o que faz o QR aparecer e o
 * "conectado" chegar sozinho. Com a aba escondida o tick continuava saindo:
 * cada um é uma consulta ao transporte, numa tela em que ninguém está
 * escaneando nada. A guarda é a convenção da casa, a mesma do refetch de
 * segurança (`hooks/realtime/useRefetchDeSeguranca.ts`, PR #2821); a
 * atualização da interface (`hooks/auth/InterfaceRefresh.tsx`) também pula o
 * trabalho de rede com a aba oculta.
 *
 * O que este arquivo prova, sem mudar a cadência de 3 s: com a aba visível o
 * refetch continua correndo (o fluxo precisa acompanhar o pareamento), com a
 * aba oculta ele para, e volta a correr quando a aba retorna.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type * as CanaisModule from "@/hooks/channels/useChannelSessions";
import type { ChannelSession } from "@/hooks/channels/useChannelSessions";

const getMock = vi.fn();
const postMock = vi.fn();
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: (...a: unknown[]) => getMock(...a),
    post: (...a: unknown[]) => postMock(...a),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock("@/hooks/channels/usePacingKnobs", () => ({ usePacingKnobs: () => ({ data: { items: [] } }) }));
vi.mock("@/components/connections/AntiBanSheet", () => ({ AntiBanSheet: () => null }));

const listagem: {
  data: ChannelSession[] | undefined;
  isLoading: boolean;
  isError: boolean;
  schemaOutdated: boolean;
} = { data: [], isLoading: false, isError: false, schemaOutdated: false };

vi.mock("@/hooks/channels/useChannelSessions", async (original) => {
  const real = await original<typeof CanaisModule>();
  return { ...real, useChannelSessions: () => listagem };
});

import { ConnectionsClient } from "@/components/connections/ConnectionsClient";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function canal(id: string, over: Partial<ChannelSession> = {}): ChannelSession {
  return {
    id,
    waha_session_name: `org_1111_${id.slice(0, 3)}`,
    display_name: `Número ${id.slice(0, 1).toUpperCase()}`,
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

/** A convenção da casa, espelhada de hooks/realtime/useRefetchDeSeguranca.test.tsx. */
let visibilidade: DocumentVisibilityState = "visible";

function definirVisibilidade(valor: DocumentVisibilityState) {
  visibilidade = valor;
  document.dispatchEvent(new Event("visibilitychange"));
}

let qc: QueryClient;

function wrap(ui: React.ReactNode) {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

/**
 * Quantas vezes o status da sessão foi consultado. A URL EXATA é a do refetch
 * do diálogo: os filhos da tela (acervo, acesso de IA, pareamento, renomear)
 * batem em URLs com sufixo, e o health check inicial consulta a mesma URL uma
 * vez só — por isso a linha de base é tirada DEPOIS dele.
 */
function consultasDeSessao(): number {
  return getMock.mock.calls.filter(([url]) => url === `/api/v1/channel-sessions/${A}`).length;
}

const esvaziar = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  visibilidade = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibilidade,
  });
  getMock.mockReset();
  postMock.mockReset();
  getMock.mockResolvedValue({ data: { status: "SCAN_QR_CODE" } });
  postMock.mockResolvedValue({ data: {} });
  listagem.data = [canal(A)];
  listagem.isLoading = false;
  listagem.isError = false;
  listagem.schemaOutdated = false;
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.restoreAllMocks();
});

describe("o pareamento não pergunta o status com a aba oculta (refs #2821)", () => {
  it("aba visível: o refetch de 3 s continua; aba oculta: ele para; na volta: corre de novo", async () => {
    // `wahaConfigured` porque é ele que oferece o Reconectar — o fluxo de
    // conexão em andamento que a guarda passa a respeitar.
    render(wrap(<ConnectionsClient wahaConfigured />));
    await esvaziar();
    await esvaziar();

    // Reconectar abre o diálogo de QR, que pergunta o status na hora.
    fireEvent.click(screen.getByRole("button", { name: /^Reconectar/ }));
    await esvaziar();
    await esvaziar();
    expect(
      screen.getByText(
        "Escolha QR Code ou código de pareamento e confirme no WhatsApp do celular.",
      ),
    ).toBeInTheDocument();

    const base = consultasDeSessao();
    expect(base, "o diálogo deveria ter consultado o status ao abrir").toBeGreaterThan(0);

    // Aba visível: o refetch de 3 s continua correndo.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(consultasDeSessao()).toBeGreaterThan(base);

    // Aba oculta: o refetch para — nada é consultado às escondidas.
    await act(async () => definirVisibilidade("hidden"));
    const comAbaOculta = consultasDeSessao();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000);
    });
    expect(consultasDeSessao(), "a aba oculta voltou a consultar o transporte").toBe(comAbaOculta);

    // De volta à aba: o refetch volta a correr.
    await act(async () => definirVisibilidade("visible"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(consultasDeSessao()).toBeGreaterThan(comAbaOculta);
  });
});
