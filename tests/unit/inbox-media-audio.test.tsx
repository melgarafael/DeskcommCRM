import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { AudioPlayer } from "@/components/inbox/media/AudioPlayer";

const aviso = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { warning: aviso, error: vi.fn(), success: vi.fn() } }));

beforeAll(() => {
  // jsdom não implementa playback — mocka o mínimo do HTMLMediaElement.
  Object.defineProperty(window.HTMLMediaElement.prototype, "play", {
    configurable: true,
    value: vi.fn().mockResolvedValue(undefined),
  });
  Object.defineProperty(window.HTMLMediaElement.prototype, "pause", {
    configurable: true,
    value: vi.fn(),
  });
});

describe("AudioPlayer", () => {
  it("renderiza com src do endpoint e controles", () => {
    render(<AudioPlayer messageId="m3" isOutbound={false} />);
    expect(screen.getByRole("button", { name: /reproduzir/i })).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: /progresso/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /velocidade/i })).toHaveTextContent("1x");
  });

  it("alterna play/pause", async () => {
    render(<AudioPlayer messageId="m3" isOutbound={false} />);
    const btn = screen.getByRole("button", { name: /reproduzir/i });
    fireEvent.click(btn);
    // O rótulo só vira "Pausar" quando o play() RESOLVE — antes ele mentia.
    expect(await screen.findByRole("button", { name: /pausar/i })).toBeInTheDocument();
  });

  it("cicla a velocidade 1x → 1.5x → 2x → 1x", () => {
    render(<AudioPlayer messageId="m3" isOutbound={false} />);
    const rate = screen.getByRole("button", { name: /velocidade/i });
    fireEvent.click(rate);
    expect(rate).toHaveTextContent("1.5x");
    fireEvent.click(rate);
    expect(rate).toHaveTextContent("2x");
    fireEvent.click(rate);
    expect(rate).toHaveTextContent("1x");
  });

  it("resiliente a duration Infinity (OGG stream): max=1 fallback, healing ao refinar", async () => {
    const { container } = render(<AudioPlayer messageId="m3" isOutbound={false} />);
    const input = screen.getByRole("slider");

    // Simula OGG report Infinity
    const audio = container.querySelector("audio") as HTMLAudioElement;
    Object.defineProperty(audio, "duration", {
      configurable: true,
      value: Infinity,
    });
    act(() => {
      audio.dispatchEvent(new Event("loadedmetadata"));
    });

    // max deve ser fallback "1"
    await waitFor(() => expect(input).toHaveAttribute("max", "1"));

    // Refina para 42
    Object.defineProperty(audio, "duration", { value: 42 });
    act(() => {
      audio.dispatchEvent(new Event("durationchange"));
    });

    // max heals para "42"
    await waitFor(() => expect(input).toHaveAttribute("max", "42"));
  });

  it("erro ao carregar exibe MediaUnavailable", async () => {
    const { container } = render(<AudioPlayer messageId="m3" isOutbound={false} />);
    const audio = container.querySelector("audio") as HTMLAudioElement;
    act(() => {
      audio.dispatchEvent(new Event("error"));
    });

    await waitFor(() => expect(screen.getByText(/mídia indisponível/i)).toBeInTheDocument());
  });
});

/**
 * F2 (ADR-0006): o Safari do iPhone antes do 18.4 não toca ogg/opus — o
 * formato de toda nota de voz do WhatsApp. O player pergunta ao próprio
 * aparelho (`canPlayType`) e, quando a resposta é "não", o primeiro toque
 * busca a versão AAC (`?formato=aac`) e toca por `blob:` — só em memória, nada
 * em Cache Storage nem IndexedDB (D4).
 */
describe("áudio que o aparelho não toca", () => {
  const playMock = () => window.HTMLMediaElement.prototype.play as unknown as ReturnType<typeof vi.fn>;

  function aparelhoToca(resposta: CanPlayTypeResult) {
    vi.spyOn(window.HTMLMediaElement.prototype, "canPlayType").mockReturnValue(resposta);
  }

  function fetchDoAac() {
    // Não é `new Response(blob)`: o Blob do jsdom não é o do undici.
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        ({ ok: true, status: 200, blob: async () => new Blob(["mp4"], { type: "audio/mp4" }) }) as Response,
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  let criar: ReturnType<typeof vi.fn>;
  let revogar: ReturnType<typeof vi.fn>;

  beforeAll(() => {
    criar = vi.fn(() => "blob:http://localhost/aac-1");
    revogar = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: criar });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revogar });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    criar.mockClear();
    revogar.mockClear();
    aviso.mockClear();
    playMock().mockReset();
    playMock().mockResolvedValue(undefined);
  });

  it("ogg num aparelho que não toca: o 1º toque busca ?formato=aac e toca por blob:, revogado ao desmontar", async () => {
    aparelhoToca("");
    const fetchMock = fetchDoAac();
    const { container, unmount } = render(
      <AudioPlayer messageId="m3" isOutbound={false} mime="audio/ogg; codecs=opus" />,
    );
    const audio = container.querySelector("audio") as HTMLAudioElement;
    // Sem src até o toque: nada de baixar um ogg que o aparelho não toca.
    await waitFor(() => expect(audio.getAttribute("src")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: /reproduzir/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/v1/messages/m3/media?formato=aac");
    await waitFor(() => expect(audio.src).toBe("blob:http://localhost/aac-1"));
    expect(await screen.findByRole("button", { name: /pausar/i })).toBeInTheDocument();

    unmount();
    expect(revogar).toHaveBeenCalledWith("blob:http://localhost/aac-1");
  });

  it("o ogg nunca chega ao <audio>, nem no primeiro commit (antes do efeito decidir)", async () => {
    // O `waitFor` acima confere DEPOIS do efeito. Aqui a sonda é o próprio
    // `setAttribute`: um `src` gravado por um instante já faz o WebKit baixar,
    // falhar e guardar o erro no elemento — e o toque seguinte não destrava.
    aparelhoToca("");
    const gravados: string[] = [];
    const original = Element.prototype.setAttribute;
    vi.spyOn(Element.prototype, "setAttribute").mockImplementation(function (
      this: Element,
      nome: string,
      valor: string,
    ) {
      if (this.tagName === "AUDIO" && nome === "src") gravados.push(valor);
      return original.call(this, nome, valor);
    });
    const { container } = render(
      <AudioPlayer messageId="m3" isOutbound={false} mime="audio/ogg; codecs=opus" />,
    );
    await waitFor(() => expect(container.querySelector("audio")).not.toBeNull());
    expect(gravados).toEqual([]);
  });

  it("aparelho que toca: nunca chama fetch e usa a rota de sempre", async () => {
    aparelhoToca("probably");
    const fetchMock = fetchDoAac();
    const { container } = render(<AudioPlayer messageId="m3" isOutbound={false} mime="audio/ogg" />);
    fireEvent.click(screen.getByRole("button", { name: /reproduzir/i }));
    await screen.findByRole("button", { name: /pausar/i });
    expect(fetchMock).not.toHaveBeenCalled();
    expect((container.querySelector("audio") as HTMLAudioElement).getAttribute("src")).toBe(
      "/api/v1/messages/m3/media",
    );
  });

  it("canPlayType mentiu: o erro do <audio> liga a conversão UMA vez, em vez de 'indisponível'", async () => {
    aparelhoToca("maybe");
    const fetchMock = fetchDoAac();
    const { container } = render(<AudioPlayer messageId="m3" isOutbound={false} mime="audio/ogg" />);
    const audio = container.querySelector("audio") as HTMLAudioElement;
    act(() => {
      audio.dispatchEvent(new Event("error"));
    });
    expect(screen.queryByText(/mídia indisponível/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /reproduzir/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // Se o arquivo convertido também falhar, aí sim: indisponível.
    act(() => {
      audio.dispatchEvent(new Event("error"));
    });
    await waitFor(() => expect(screen.getByText(/mídia indisponível/i)).toBeInTheDocument());
  });

  it("conversão em curso: o botão diz que espera e o 2º toque não pede outra", async () => {
    aparelhoToca("");
    let entregar!: (r: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((r) => (entregar = r)));
    vi.stubGlobal("fetch", fetchMock);
    render(<AudioPlayer messageId="m3" isOutbound={false} mime="audio/ogg" />);
    const botao = screen.getByRole("button", { name: /reproduzir/i });

    fireEvent.click(botao);
    await waitFor(() => expect(botao).toHaveAttribute("aria-busy", "true"));
    fireEvent.click(botao);
    fireEvent.click(botao);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      entregar({ ok: true, status: 200, blob: async () => new Blob(["mp4"]) } as Response);
    });
    expect(await screen.findByRole("button", { name: /pausar/i })).not.toHaveAttribute("aria-busy", "true");
    expect(criar).toHaveBeenCalledTimes(1);
  });

  it("muitas conversões (429): avisa e deixa tentar de novo, sem 'indisponível'", async () => {
    aparelhoToca("");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 429 }))
      .mockResolvedValueOnce({ ok: true, status: 200, blob: async () => new Blob(["mp4"]) } as Response);
    vi.stubGlobal("fetch", fetchMock);
    render(<AudioPlayer messageId="m3" isOutbound={false} mime="audio/ogg" />);

    fireEvent.click(screen.getByRole("button", { name: /reproduzir/i }));
    await waitFor(() => expect(aviso).toHaveBeenCalledWith("Muitas conversões de áudio seguidas. Tente em um minuto."));
    expect(screen.queryByText(/mídia indisponível/i)).not.toBeInTheDocument();

    const botao = await screen.findByRole("button", { name: /reproduzir/i });
    await waitFor(() => expect(botao).not.toHaveAttribute("aria-busy", "true"));
    fireEvent.click(botao);
    expect(await screen.findByRole("button", { name: /pausar/i })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("conversor ocupado (503): mesmo aviso de esperar, sem 'indisponível'", async () => {
    aparelhoToca("");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
    render(<AudioPlayer messageId="m3" isOutbound={false} mime="audio/ogg" />);
    fireEvent.click(screen.getByRole("button", { name: /reproduzir/i }));
    await waitFor(() => expect(aviso).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/mídia indisponível/i)).not.toBeInTheDocument();
  });

  it("navegador que toca ogg com certeza: mídia quebrada é 'indisponível' na hora, sem conversão", async () => {
    // O Chrome responde "maybe" para `audio/ogg` puro e "probably" com o codec:
    // a pergunta leva `codecs=opus` quando o mime veio sem.
    vi.spyOn(window.HTMLMediaElement.prototype, "canPlayType").mockImplementation((tipo: string) =>
      /codecs="?opus/.test(tipo) ? "probably" : "maybe",
    );
    const fetchMock = fetchDoAac();
    const { container } = render(<AudioPlayer messageId="m3" isOutbound={false} mime="audio/ogg" />);
    const audio = container.querySelector("audio") as HTMLAudioElement;
    act(() => {
      audio.dispatchEvent(new Event("error"));
    });
    await waitFor(() => expect(screen.getByText(/mídia indisponível/i)).toBeInTheDocument());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a conversão falhou no servidor: indisponível, sem tentar tocar", async () => {
    aparelhoToca("");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 502 })));
    render(<AudioPlayer messageId="m3" isOutbound={false} mime="audio/ogg" />);
    fireEvent.click(screen.getByRole("button", { name: /reproduzir/i }));
    await waitFor(() => expect(screen.getByText(/mídia indisponível/i)).toBeInTheDocument());
    expect(criar).not.toHaveBeenCalled();
  });

  it("áudio de nota interna (src próprio) não entra na conversão", async () => {
    aparelhoToca("");
    const fetchMock = fetchDoAac();
    const { container } = render(
      <AudioPlayer messageId="n1" isOutbound={false} mime="audio/ogg" src="/api/v1/notes/x/media" />,
    );
    fireEvent.click(screen.getByRole("button", { name: /reproduzir/i }));
    await screen.findByRole("button", { name: /pausar/i });
    expect(fetchMock).not.toHaveBeenCalled();
    expect((container.querySelector("audio") as HTMLAudioElement).getAttribute("src")).toBe(
      "/api/v1/notes/x/media",
    );
  });

  it("play() recusado (Safari fora do gesto): o botão volta a 'Reproduzir' para o 2º toque", async () => {
    playMock().mockRejectedValue(new DOMException("not allowed", "NotAllowedError"));
    render(<AudioPlayer messageId="m3" isOutbound={false} />);
    fireEvent.click(screen.getByRole("button", { name: /reproduzir/i }));
    await waitFor(() => expect(playMock()).toHaveBeenCalled());
    expect(await screen.findByRole("button", { name: /reproduzir/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /pausar/i })).not.toBeInTheDocument();
  });
});
