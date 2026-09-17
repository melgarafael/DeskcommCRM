/**
 * UMA PERNA DE ÁUDIO POR LIGAÇÃO, E O PAINEL QUE SABE QUANDO ELA ACABOU.
 *
 * Medido em produção em 2026-09-15 (VPS, versão 1.27.2): o dono ligou pelo CRM
 * e atendeu no celular. Ninguém ouviu ninguém. A trilha de auditoria tinha DOIS
 * `voice.call_media_attached` com 7 ms de diferença, e havia duas assinaturas de
 * `voice_calls` do mesmo usuário abertas. O WaCalls guarda uma ponte de áudio
 * por chamada e fecha a anterior em silêncio (`setBridge`), então a ponte que
 * sobrou era a do documento que ninguém usava. Depois o celular desligou, o
 * banco registrou "ended", e o painel ficou 66 s na tela até dois cliques em
 * encerrar gravarem dois `voice.call_ended`.
 *
 * Este arquivo monta o hook de verdade, com dublês do navegador, e mede o que a
 * tela e a rede fazem em cada um desses caminhos.
 */
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const espiao = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  del: vi.fn(),
  onChange: null as ((p: unknown) => void) | null,
}));

vi.mock("@/lib/api/client", () => ({
  apiClient: { get: espiao.get, post: espiao.post, delete: espiao.del },
}));
vi.mock("@/hooks/realtime/useRealtimeChannel", () => ({
  useRealtimeChannel: (opcoes: { onChange?: (p: unknown) => void }) => {
    espiao.onChange = opcoes.onChange ?? null;
    return { status: "SUBSCRIBED" };
  },
}));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("@/app/providers", () => ({
  Providers: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/lib/supabase/browser", () => ({
  createClient: () => ({ auth: { refreshSession: vi.fn() } }),
  resetRealtimeAuthentication: vi.fn(),
}));

import { AuthProvider } from "@/hooks/auth/AuthProvider";
import type { ActiveOrg, AuthUser } from "@/lib/auth/types";
import { RECONCILIAR_CHAMADA_MS, useVoiceCallSession } from "@/hooks/voice/useVoiceCallSession";

const ORG = "11111111-1111-4111-8111-111111111111";
const EU = "22222222-2222-4222-8222-222222222222";
const CHAMADA = "33333333-3333-4333-8333-333333333333";
const CONTATO = "44444444-4444-4444-8444-444444444444";

interface ConexaoFalsa {
  connectionState: RTCPeerConnectionState;
  onconnectionstatechange: (() => void) | null;
  fechada: boolean;
}
let conexoes: ConexaoFalsa[] = [];
let trilhas: Array<{ stop: ReturnType<typeof vi.fn> }> = [];
/** Quando definido, `getUserMedia` fica pendente até o teste chamar. */
let liberarMicrofone: (() => void) | null = null;
let microfoneAdiado = false;

function instalarDublesDoNavegador() {
  conexoes = [];
  trilhas = [];
  liberarMicrofone = null;
  microfoneAdiado = false;

  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: vi.fn(async () => {
        const trilha = { stop: vi.fn(), enabled: true };
        trilhas.push(trilha);
        if (microfoneAdiado) await new Promise<void>((r) => (liberarMicrofone = r));
        return { getTracks: () => [trilha], getAudioTracks: () => [trilha] };
      }),
    },
  });

  class RTCPeerConnectionFalsa {
    connectionState: RTCPeerConnectionState = "new";
    iceGatheringState: RTCIceGatheringState = "complete";
    localDescription = { sdp: "v=0 oferta" };
    onconnectionstatechange: (() => void) | null = null;
    fechada = false;
    constructor() {
      conexoes.push(this as unknown as ConexaoFalsa);
    }
    createDataChannel(label: string) {
      return { label, readyState: "connecting", binaryType: "blob", onopen: null, onmessage: null, send: vi.fn(), close: vi.fn() };
    }
    async createOffer() {
      return { type: "offer", sdp: "v=0 oferta" };
    }
    async setLocalDescription() {}
    async setRemoteDescription() {}
    addEventListener() {}
    removeEventListener() {}
    close() {
      this.fechada = true;
    }
  }
  class AudioWorkletNodeFalso {
    port = { onmessage: null, postMessage: vi.fn() };
    connect() {}
    disconnect() {}
  }
  class AudioContextFalso {
    destination = {};
    audioWorklet = { addModule: vi.fn(async () => {}) };
    async resume() {}
    async close() {}
    createMediaStreamSource() {
      return { connect: () => {} };
    }
    createMediaStreamDestination() {
      return { stream: {} };
    }
  }
  vi.stubGlobal("RTCPeerConnection", RTCPeerConnectionFalsa);
  vi.stubGlobal("AudioWorkletNode", AudioWorkletNodeFalso);
  vi.stubGlobal("AudioContext", AudioContextFalso);
  (globalThis as unknown as { window: Record<string, unknown> }).window.AudioContext =
    AudioContextFalso as unknown as typeof AudioContext;
}

function linha(over: Record<string, unknown> = {}) {
  return {
    id: CHAMADA,
    contact_id: CONTATO,
    direction: "outbound",
    peer_phone: "553198966398",
    status: "ringing",
    end_reason: null,
    started_at: new Date().toISOString(),
    answered_at: null,
    owner_user_id: EU,
    created_by: EU,
    ...over,
  };
}

const conectada = () => linha({ status: "connected", answered_at: new Date().toISOString() });

async function assentar(voltas = 12) {
  for (let i = 0; i < voltas; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function postsDeMidia() {
  return espiao.post.mock.calls.filter((c) => String(c[0]).endsWith("/webrtc"));
}

async function montar() {
  const ref = { current: null };
  const user = { id: EU, email: "q@e.com", full_name: "Q", avatar_url: null, is_platform_admin: false, idioma: "pt-BR", organizations: [] } as AuthUser;
  const activeOrg: ActiveOrg = { orgId: ORG, name: "Org", role: "agent" };
  const vista = renderHook(() => useVoiceCallSession(ref), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <AuthProvider user={user} activeOrg={activeOrg}>
        {children}
      </AuthProvider>
    ),
  });
  await assentar();
  return vista;
}

async function entregar(row: Record<string, unknown>) {
  await act(async () => {
    espiao.onChange?.({ new: row });
  });
  await assentar();
}

beforeEach(() => {
  vi.clearAllMocks();
  window.sessionStorage.clear();
  vi.useFakeTimers();
  instalarDublesDoNavegador();
  espiao.get.mockResolvedValue({ data: [] });
  espiao.del.mockResolvedValue(undefined);
  espiao.post.mockImplementation(async (url: string) =>
    String(url).endsWith("/webrtc") ? { data: { sdpAnswer: "v=0 resposta" } } : { data: linha() },
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("só a aba do gesto abre o áudio", () => {
  it("OUTRA aba do mesmo usuário recebe 'connected' e NÃO troca a ponte — avisa", async () => {
    // O incidente: esta aba não discou, mas a ligação é do mesmo usuário.
    const { result } = await montar();
    await entregar(conectada());
    expect(postsDeMidia(), "abriu áudio numa aba que não discou — derruba a ponte da aba certa").toHaveLength(0);
    expect(conexoes).toHaveLength(0);
    expect(result.current.midiaEmOutraAba).toBe(true);
  });

  it("'Chamar' abre o áudio NO GESTO, ainda tocando, uma vez só — e o 'connected' não abre de novo", async () => {
    const { result } = await montar();
    await act(async () => {
      await result.current.startCall(CONTATO);
    });
    await assentar();
    expect(postsDeMidia(), "o áudio não abriu no clique").toHaveLength(1);
    // A troca carrega o id aleatório da aba — é a prova no audit em produção.
    expect((postsDeMidia()[0]![1] as { aba?: string }).aba).toMatch(/^[0-9a-f-]{36}$/);

    await entregar(linha({ status: "ringing" }));
    await entregar(conectada());
    await entregar(conectada());
    expect(postsDeMidia(), "dois 'connected' abriram duas pernas").toHaveLength(1);
    expect(result.current.midiaEmOutraAba).toBe(false);
  });

  it("recarregar no meio da ligação: a aba dona reabre uma vez, mesmo com dois 'connected' e o microfone pendente", async () => {
    window.sessionStorage.setItem("voz:midia", CHAMADA);
    microfoneAdiado = true;
    await montar();
    await entregar(conectada());
    await entregar(conectada());
    await act(async () => liberarMicrofone?.());
    await assentar();
    expect(postsDeMidia()).toHaveLength(1);
  });

  it("troca de SDP que falha não entra em laço de novas tentativas", async () => {
    window.sessionStorage.setItem("voz:midia", CHAMADA);
    espiao.post.mockImplementation(async (url: string) => {
      if (String(url).endsWith("/webrtc")) throw new Error("wacalls_502");
      return { data: linha() };
    });
    await montar();
    await entregar(conectada());
    await entregar(conectada());
    await entregar(conectada());
    expect(postsDeMidia()).toHaveLength(1);
  });

  it("'Ouvir aqui' traz o áudio para esta aba: uma troca nova, e o aviso some", async () => {
    const { result } = await montar();
    await entregar(conectada());
    expect(result.current.midiaEmOutraAba).toBe(true);
    await act(async () => result.current.ouvirAqui());
    await assentar();
    expect(postsDeMidia()).toHaveLength(1);
    expect(window.sessionStorage.getItem("voz:midia")).toBe(CHAMADA);
    expect(result.current.midiaEmOutraAba).toBe(false);
  });

  it("tentativa superada não pendura microfone nem manda oferta: a ligação acaba com o microfone pendente", async () => {
    window.sessionStorage.setItem("voz:midia", CHAMADA);
    microfoneAdiado = true;
    await montar();
    await entregar(conectada());
    await entregar(linha({ status: "ended" }));
    await act(async () => liberarMicrofone?.());
    await assentar();
    expect(postsDeMidia(), "a tentativa morta ainda trocou SDP — derrubaria a ponte de outra").toHaveLength(0);
    expect(trilhas.every((t) => t.stop.mock.calls.length > 0), "microfone ficou aceso").toBe(true);
    expect(conexoes.every((c) => c.fechada)).toBe(true);
  });

  it("a tentativa superada não deixa restos: a PRÓXIMA ligação desta aba ainda abre o áudio", async () => {
    // Uma tentativa que volta do microfone depois de a ligação acabar e se
    // pendura nos refs (conexão já fechada em `pcRef`) faz o efeito achar que
    // já há mídia — e a ligação seguinte, recarregada nesta aba, fica muda.
    window.sessionStorage.setItem("voz:midia", CHAMADA);
    microfoneAdiado = true;
    await montar();
    await entregar(conectada());
    await entregar(linha({ status: "ended" }));
    await act(async () => liberarMicrofone?.());
    await assentar();

    microfoneAdiado = false;
    const SEGUNDA = "77777777-7777-4777-8777-777777777777";
    window.sessionStorage.setItem("voz:midia", SEGUNDA);
    await entregar(linha({ id: SEGUNDA, status: "connected", answered_at: new Date().toISOString() }));
    expect(postsDeMidia().map((c) => String(c[0]))).toEqual([`/api/v1/voice/calls/${SEGUNDA}/webrtc`]);
  });

  it("microfone negado no clique: o painel diz que falhou e 'Tentar de novo' abre uma tentativa nova", async () => {
    // A trava contra laço deixava o estado em `ociosa` e o painel em "Abrindo o
    // áudio…" para sempre, sem botão — a primeira ligação de quem nunca deu
    // permissão ao microfone.
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      Object.assign(new Error("Permission denied"), { name: "NotAllowedError" }),
    );
    const { result } = await montar();
    await act(async () => {
      await result.current.startCall(CONTATO);
    });
    await assentar();
    expect(result.current.estadoDaMidia).toBe("falhou");
    await entregar(conectada());
    expect(result.current.estadoDaMidia, "o 'connected' apagou o aviso de falha").toBe("falhou");
    expect(postsDeMidia()).toHaveLength(0);

    await act(async () => result.current.ouvirAqui());
    await assentar();
    expect(postsDeMidia()).toHaveLength(1);
    expect(result.current.estadoDaMidia).toBe("negociando");
  });

  it("recarregar prefere a ligação marcada nesta aba, mesmo com outra mais nova na organização", async () => {
    window.sessionStorage.setItem("voz:midia", CHAMADA);
    const OUTRA = "88888888-8888-4888-8888-888888888888";
    espiao.get.mockImplementation(async (url: string) =>
      String(url).includes(`id=${CHAMADA}`)
        ? { data: [conectada()] }
        : { data: [linha({ id: OUTRA, status: "ringing", direction: "inbound", owner_user_id: null, created_by: null })] },
    );
    const { result } = await montar();
    expect(result.current.call?.id, "adotou a ligação mais nova da organização").toBe(CHAMADA);
    expect(postsDeMidia().map((c) => String(c[0]))).toEqual([`/api/v1/voice/calls/${CHAMADA}/webrtc`]);
  });

  it("a marca da aba é apagada quando a ligação que ela marcou acaba", async () => {
    const { result } = await montar();
    await act(async () => {
      await result.current.startCall(CONTATO);
    });
    await assentar();
    expect(window.sessionStorage.getItem("voz:midia")).toBe(CHAMADA);
    await entregar(linha({ status: "ended" }));
    expect(window.sessionStorage.getItem("voz:midia")).toBeNull();
  });
});

describe("o painel percebe o fim mesmo sem o aviso do tempo real", () => {
  it("o 'ended' que não chegou: em até um intervalo, o servidor diz que acabou e o painel some", async () => {
    window.sessionStorage.setItem("voz:midia", CHAMADA);
    const { result } = await montar();
    await entregar(conectada());
    expect(result.current.call?.status).toBe("connected");

    // Só as consultas DA CONFERÊNCIA contam: a carga da página, com a marca da
    // aba, já busca pelo id — medir "alguma consulta com id" acertava por sorte.
    espiao.get.mockClear();
    espiao.get.mockResolvedValue({ data: [linha({ status: "ended" })] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RECONCILIAR_CHAMADA_MS);
    });
    await assentar();
    expect(result.current.call, "painel fantasma: o banco disse ended e a tela não soube").toBeNull();
    // Pelo id: entre "as 5 mais recentes" a ligação sai da janela num escritório movimentado.
    const daConferencia = espiao.get.mock.calls.map((c) => String(c[0]));
    expect(daConferencia.length).toBeGreaterThan(0);
    expect(daConferencia.every((u) => u.includes(`id=${CHAMADA}`)), daConferencia.join(" | ")).toBe(true);
    expect(trilhas.every((t) => t.stop.mock.calls.length > 0)).toBe(true);
  });

  it("o canal voltou ('reassinado'): confere na hora, sem esperar o intervalo", async () => {
    const { result } = await montar();
    await entregar(conectada());
    espiao.get.mockClear();
    espiao.get.mockResolvedValue({ data: [linha({ status: "ended" })] });
    await act(async () => {
      espiao.onChange?.({ tipo: "reassinado" });
    });
    await assentar();
    expect(espiao.get).toHaveBeenCalledTimes(1);
    expect(result.current.call).toBeNull();
  });

  it("a conexão de áudio caiu: confere na hora — é a primeira notícia do fim", async () => {
    window.sessionStorage.setItem("voz:midia", CHAMADA);
    const { result } = await montar();
    await entregar(conectada());
    espiao.get.mockClear();
    espiao.get.mockResolvedValue({ data: [linha({ status: "ended" })] });
    await act(async () => {
      const pc = conexoes.at(-1)!;
      pc.connectionState = "closed";
      pc.onconnectionstatechange?.();
    });
    await assentar();
    expect(espiao.get).toHaveBeenCalledTimes(1);
    expect(result.current.call).toBeNull();
  });

  it("leitura velha não ressuscita a ligação encerrada", async () => {
    const { result } = await montar();
    await entregar(conectada());
    await entregar(linha({ status: "ended" }));
    expect(result.current.call).toBeNull();
    await entregar(conectada());
    expect(result.current.call, "um evento atrasado trouxe o painel de volta").toBeNull();
  });

  it("controle: leitura do servidor com status ANTERIOR não rebaixa a ligação", async () => {
    const { result } = await montar();
    await entregar(conectada());
    espiao.get.mockResolvedValue({ data: [linha({ status: "ringing" })] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RECONCILIAR_CHAMADA_MS);
    });
    await assentar();
    expect(result.current.call?.status).toBe("connected");
  });

  it("sem ligação, nenhuma consulta além do boot", async () => {
    await montar();
    const antes = espiao.get.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RECONCILIAR_CHAMADA_MS * 6);
    });
    expect(espiao.get.mock.calls.length).toBe(antes);
  });
});

describe("encerrar sai uma vez", () => {
  it("dois cliques seguidos em encerrar mandam UM pedido", async () => {
    let responder!: () => void;
    espiao.del.mockImplementation(() => new Promise<void>((r) => (responder = r)));
    const { result } = await montar();
    await entregar(conectada());
    let a!: Promise<void>;
    let b!: Promise<void>;
    act(() => {
      a = result.current.hangUp();
      b = result.current.hangUp();
    });
    expect(result.current.encerrando).toBe(true);
    await act(async () => {
      responder();
      await Promise.all([a, b]);
    });
    expect(espiao.del).toHaveBeenCalledTimes(1);
    expect(result.current.call).toBeNull();
  });
});
