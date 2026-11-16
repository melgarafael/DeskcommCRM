/**
 * Central de Conexões — o caminho DE VOLTA ao QR.
 *
 * Três becos sem saída medidos na instalação real (piloto Apex, 10/11/2026):
 *
 *  1. Um canal em `SCAN_QR_CODE` mostrava o selo "Escaneie o QR" — um rótulo
 *     que parece botão e não faz nada quando clicado. Quem está pareando não
 *     tem para onde ir a partir dele.
 *  2. A faixa de conexão caída dizia "Escanear o QR" e linkava para a própria
 *     Central de Conexões — inclusive quando a pessoa JÁ ESTAVA nela. O clique
 *     navegava para a página em que estava.
 *  3. Um número que NUNCA pareou (`phone_number` null) em FAILED/STOPPED não
 *     tinha caminho de volta: o start suave devolve o mesmo FAILED sem nunca
 *     passar por `SCAN_QR_CODE` (o buraco descrito na rota de reconectar), e o
 *     `force` — o único que devolve um QR — morava escondido dentro do diálogo
 *     de pareamento, que só abria depois de uma tentativa suave fracassada.
 *
 * A régua do `force`: DESCARTA a credencial de forma irreversível, então é
 * oferecido só a quem NUNCA pareou (`phone_number` null) — um canal com
 * telefone tem credencial guardada, e reescaneá-la à toa não é devesse. A
 * guarda vive em DOIS lugares (render do botão e clique), porque a UI pode
 * mudar e a guarda não.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
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

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: { success: (m: string) => toastSuccess(m), error: (m: string) => toastError(m) },
}));

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

vi.mock("@/hooks/channels/useChannelSessions", async (original) => {
  const real = await original<typeof CanaisModule>();
  return { ...real, useChannelSessions: () => listagem };
});

import { ConnectionsClient } from "@/components/connections/ConnectionsClient";
import { qrDaUrl } from "@/components/connections/ConexoesShell";

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

/** As consultas que a tela e o diálogo de pareamento fazem, roteadas por URL. */
function getPorUrl(status = "SCAN_QR_CODE") {
  getMock.mockImplementation((url: unknown) => {
    const alvo = String(url);
    if (alvo === "/api/v1/settings/routing/channels") {
      return Promise.resolve({ data: { data: { channels: [] } } });
    }
    if (alvo === "/api/v1/channel-sessions/canal-1") {
      return Promise.resolve({ data: { status } });
    }
    return Promise.reject(new Error(`GET inesperado: ${alvo}`));
  });
}

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
  toastError.mockReset();
  toastSuccess.mockReset();
  listagem.data = [canal()];
  listagem.isLoading = false;
  listagem.isError = false;
  listagem.schemaOutdated = false;
  getPorUrl();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("o selo SCAN_QR_CODE é um botão, não um rótulo", () => {
  it("canal aguardando pareamento abre o diálogo do QR pelo próprio selo", async () => {
    listagem.data = [canal({ status: "SCAN_QR_CODE" })];

    render(wrap(<ConnectionsClient wahaConfigured />));

    const botao = screen.getByRole("button", { name: "Mostrar o QR" });
    fireEvent.click(botao);

    // O diálogo pergunta ao transporte o estado da sessão e desenha o QR do
    // momento — não um rótulo parado.
    await waitFor(() =>
      expect(getMock).toHaveBeenCalledWith("/api/v1/channel-sessions/canal-1"),
    );
    expect(await screen.findByAltText("QR Code para conectar WhatsApp")).toBeVisible();
  });

  it("canal conectado continua com selo de leitura, sem botão de QR", () => {
    render(wrap(<ConnectionsClient wahaConfigured />));

    expect(screen.queryByRole("button", { name: "Mostrar o QR" })).toBeNull();
  });
});

describe("nunca pareado em FAILED/STOPPED tem o caminho de volta", () => {
  it("FAILED sem credencial oferece Gerar novo QR e força com { force: true }", async () => {
    listagem.data = [canal({ phone_number: null, display_name: null, status: "FAILED" })];

    render(wrap(<ConnectionsClient wahaConfigured />));

    postMock.mockResolvedValue({});
    fireEvent.click(screen.getByRole("button", { name: "Gerar novo QR" }));

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith("/api/v1/channel-sessions/canal-1/reconnect", {
        force: true,
      }),
    );
    expect(await screen.findByAltText("QR Code para conectar WhatsApp")).toBeVisible();
  });

  it("STOPPED sem credencial oferece o mesmo", () => {
    listagem.data = [canal({ phone_number: null, display_name: null, status: "STOPPED" })];

    render(wrap(<ConnectionsClient wahaConfigured />));

    expect(screen.getByRole("button", { name: "Gerar novo QR" })).toBeVisible();
  });

  it.each(["FAILED", "STOPPED"] as const)("canal PAREADO em %s NÃO oferece o force — a credencial é dele", (status) => {
    listagem.data = [canal({ status })];

    render(wrap(<ConnectionsClient wahaConfigured />));

    expect(screen.queryByRole("button", { name: "Gerar novo QR" })).toBeNull();
    // O caminho para um pareado é o suave, que preserva a credencial.
    expect(screen.getByRole("button", { name: "Reconectar" })).toBeVisible();
  });

  it("canal oficial (sem sessão no transporte) não oferece nenhum dos dois", () => {
    listagem.data = [canal({ waha_session_name: null, phone_number: null, status: "FAILED" })];

    render(wrap(<ConnectionsClient wahaConfigured />));

    expect(screen.queryByRole("button", { name: "Gerar novo QR" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reconectar" })).toBeNull();
  });
});

describe("deep-link ?qr=<id> abre o pareamento direto", () => {
  it("qrInicial abre o diálogo na montagem, sem clique nenhum", async () => {
    render(wrap(<ConnectionsClient wahaConfigured qrInicial="canal-1" />));

    // É o destino da faixa "Escanear o QR": o clique tem que mostrar o QR, e
    // não a lista em que o selo costumava ser um rótulo morto.
    await waitFor(() =>
      expect(getMock).toHaveBeenCalledWith("/api/v1/channel-sessions/canal-1"),
    );
    expect(await screen.findByAltText("QR Code para conectar WhatsApp")).toBeVisible();
  });

  it("sem qrInicial a tela começa na lista, como sempre", () => {
    render(wrap(<ConnectionsClient wahaConfigured />));

    expect(screen.queryByAltText("QR Code para conectar WhatsApp")).toBeNull();
  });
});

describe("?qr= com a Central já aberta (navegação suave, sem remontar)", () => {
  it("o qrInicial que chega depois da montagem abre o QR", async () => {
    const { rerender } = render(wrap(<ConnectionsClient wahaConfigured />));
    rerender(wrap(<ConnectionsClient wahaConfigured qrInicial="canal-1" />));

    expect(await screen.findByAltText("QR Code para conectar WhatsApp")).toBeVisible();
  });

  it("fechar tira o ?qr= e o segundo clique na faixa abre de novo", async () => {
    const fechou = vi.fn();
    const { rerender } = render(
      wrap(<ConnectionsClient wahaConfigured qrInicial="canal-1" aoFecharQrInicial={fechou} />),
    );
    expect(await screen.findByAltText("QR Code para conectar WhatsApp")).toBeVisible();

    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(fechou).toHaveBeenCalledTimes(1));

    // O que a Shell faz ao receber o aviso: a URL perde o ?qr=.
    rerender(wrap(<ConnectionsClient wahaConfigured aoFecharQrInicial={fechou} />));
    expect(screen.queryByAltText("QR Code para conectar WhatsApp")).toBeNull();

    rerender(wrap(<ConnectionsClient wahaConfigured qrInicial="canal-1" aoFecharQrInicial={fechou} />));
    expect(await screen.findByAltText("QR Code para conectar WhatsApp")).toBeVisible();
  });
});

describe("o ?qr= só aceita id de canal", () => {
  it("UUID passa", () => {
    expect(qrDaUrl("3f2b8c1e-9a4d-4e7f-b6c5-0d1e2f3a4b5c")).toBe("3f2b8c1e-9a4d-4e7f-b6c5-0d1e2f3a4b5c");
  });

  it.each([null, "", "canal-1", "../x", "3f2b8c1e-9a4d-4e7f-b6c5-0d1e2f3a4b5c/extra"])("%s não abre nada", (v) => {
    expect(qrDaUrl(v)).toBeUndefined();
  });
});
