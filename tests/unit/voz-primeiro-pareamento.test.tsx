import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), erro: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: api }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("sonner", () => ({ toast: { error: api.erro, success: vi.fn() } }));

import { CanalVozClient } from "@/components/connections/CanalVozClient";

class Eventos {
  static abertos: Eventos[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((evento: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();
  constructor() {
    Eventos.abertos.push(this);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  Eventos.abertos = [];
  vi.stubGlobal("EventSource", Eventos);
  api.get.mockImplementation(async (url: string) => ({
    data: url.endsWith("opt-in") ? { ligada: true } : { paired: false },
  }));
  api.post.mockResolvedValue({ data: {} });
});
afterEach(() => vi.unstubAllGlobals());

describe("primeiro pareamento da voz", () => {
  it("abre os eventos primeiro e só então pede o pareamento — um POST, sem 'preparar'", async () => {
    render(<CanalVozClient wacallsConfigured />);
    fireEvent.click(await screen.findByRole("button", { name: "Parear chamada de voz" }));
    // A stream nasce ANTES de qualquer POST: o QR sai no instante em que a
    // sessão é criada, e quem não está ouvindo o perde.
    await waitFor(() => expect(Eventos.abertos).toHaveLength(1));
    expect(api.post).not.toHaveBeenCalled();
    await act(async () => Eventos.abertos[0]!.onopen?.());
    expect(api.post).toHaveBeenCalledExactlyOnceWith("/api/v1/voice/sessions/pair", {});
    await act(async () =>
      Eventos.abertos[0]!.onmessage?.({
        data: JSON.stringify({ type: "qr", dataUrl: "data:image/png;base64,cXI=" }),
      }),
    );
    expect(screen.getByAltText("QR Code para parear chamada de voz")).toBeVisible();
    // O `onopen` pode disparar de novo numa reconexão do EventSource; o
    // pareamento não pode ser pedido duas vezes por isso.
    await act(async () => Eventos.abertos[0]!.onopen?.());
    expect(api.post).toHaveBeenCalledTimes(1);
  });

  it("QR vencido some da tela, avisa, e o botão volta — em vez de deixar um código morto", async () => {
    render(<CanalVozClient wacallsConfigured />);
    fireEvent.click(await screen.findByRole("button", { name: "Parear chamada de voz" }));
    await waitFor(() => expect(Eventos.abertos).toHaveLength(1));
    await act(async () => Eventos.abertos[0]!.onopen?.());
    await act(async () =>
      Eventos.abertos[0]!.onmessage?.({
        data: JSON.stringify({ type: "qr", dataUrl: "data:image/png;base64,cXI=" }),
      }),
    );
    expect(screen.getByAltText("QR Code para parear chamada de voz")).toBeVisible();
    await act(async () => Eventos.abertos[0]!.onmessage?.({ data: JSON.stringify({ type: "expired" }) }));
    expect(screen.queryByAltText("QR Code para parear chamada de voz")).toBeNull();
    expect(api.erro).toHaveBeenCalledWith("O código de pareamento venceu. Clique em parear para gerar outro.");
    expect(Eventos.abertos[0]!.close).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Parear chamada de voz" })).toBeEnabled();
  });

  it("409 'já pareada' relê o estado da tela — a rota acabou de corrigir o banco", async () => {
    api.post.mockRejectedValueOnce(new Error("voice_already_paired"));
    render(<CanalVozClient wacallsConfigured />);
    fireEvent.click(await screen.findByRole("button", { name: "Parear chamada de voz" }));
    await waitFor(() => expect(Eventos.abertos).toHaveLength(1));
    const leiturasAntes = api.get.mock.calls.filter((c) => String(c[0]).endsWith("/status")).length;
    await act(async () => Eventos.abertos[0]!.onopen?.());
    await waitFor(() =>
      expect(api.get.mock.calls.filter((c) => String(c[0]).endsWith("/status")).length).toBe(leiturasAntes + 1),
    );
  });

  it("queda da conexão com o QR na tela tira o código morto e devolve o botão", async () => {
    render(<CanalVozClient wacallsConfigured />);
    fireEvent.click(await screen.findByRole("button", { name: "Parear chamada de voz" }));
    await waitFor(() => expect(Eventos.abertos).toHaveLength(1));
    await act(async () => Eventos.abertos[0]!.onopen?.());
    await act(async () =>
      Eventos.abertos[0]!.onmessage?.({
        data: JSON.stringify({ type: "qr", dataUrl: "data:image/png;base64,cXI=" }),
      }),
    );
    act(() => Eventos.abertos[0]!.onerror?.());
    expect(screen.queryByAltText("QR Code para parear chamada de voz")).toBeNull();
    expect(screen.getByRole("button", { name: "Parear chamada de voz" })).toBeEnabled();
  });

  it("falha da conexão avisa a pessoa e permite tentar de novo", async () => {
    render(<CanalVozClient wacallsConfigured />);
    fireEvent.click(await screen.findByRole("button", { name: "Parear chamada de voz" }));
    await waitFor(() => expect(Eventos.abertos).toHaveLength(1));
    act(() => Eventos.abertos[0]!.onerror?.());
    expect(api.erro).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Parear chamada de voz" })).toBeEnabled();
  });
});
