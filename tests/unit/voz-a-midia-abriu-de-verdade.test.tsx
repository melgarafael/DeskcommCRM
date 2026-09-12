/**
 * A falha-em-verde da chamada de voz: o cronômetro corria em silêncio.
 *
 * `voice_calls.status` diz que o WHATSAPP atendeu. Não diz nada sobre o áudio
 * chegar até este navegador — são dois transportes, e na VPS o segundo é o que
 * quebra (porta UDP não publicada, `WACALLS_PUBLIC_IP` vazio: o WaCalls anuncia
 * como candidato o IP interno do contêiner). Antes deste conserto, NADA no
 * código escutava a `RTCPeerConnection`: a troca de SDP é HTTP e funciona, então
 * o painel mostrava "0:14" correndo, sem aviso, com zero som.
 *
 * O que este arquivo guarda é COMPORTAMENTO — ele monta o hook de verdade, com
 * dublês do navegador, e mede o estado que a tela consome em cada desfecho real:
 * canal abre, áudio chega, ICE falha, prazo vence. Guardar a presença de um
 * `dc.onopen` no fonte seria guardar o call site, não o efeito.
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
import { useVoiceCallSession } from "@/hooks/voice/useVoiceCallSession";

const ORG = "11111111-1111-4111-8111-111111111111";
const EU = "22222222-2222-4222-8222-222222222222";
const CHAMADA = "33333333-3333-4333-8333-333333333333";

/** O canal `pcm` que o WaCalls exige — os handlers que o hook pendura nele. */
interface CanalFalso {
  label: string;
  readyState: RTCDataChannelState;
  binaryType: string;
  onopen: (() => void) | null;
  onmessage: ((e: { data: ArrayBuffer }) => void) | null;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

interface ConexaoFalsa {
  connectionState: RTCPeerConnectionState;
  iceGatheringState: RTCIceGatheringState;
  localDescription: { sdp: string };
  onconnectionstatechange: (() => void) | null;
  canal: CanalFalso;
}

/** A última conexão que o hook abriu — é nela que o teste bate. */
let conexao: ConexaoFalsa | null = null;
/** Os `AudioWorkletNode` criados, por nome — o de playback é quem toca o som. */
let worklets: Record<string, { port: { postMessage: ReturnType<typeof vi.fn> } }> = {};

function instalarDublesDoNavegador() {
  conexao = null;
  worklets = {};

  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn(), enabled: true }] })),
    },
  });

  class RTCPeerConnectionFalsa {
    connectionState: RTCPeerConnectionState = "new";
    iceGatheringState: RTCIceGatheringState = "complete";
    localDescription = { sdp: "v=0 oferta" };
    onconnectionstatechange: (() => void) | null = null;
    canal!: CanalFalso;
    constructor() {
      conexao = this as unknown as ConexaoFalsa;
    }
    createDataChannel(label: string): CanalFalso {
      this.canal = {
        label,
        readyState: "connecting",
        binaryType: "blob",
        onopen: null,
        onmessage: null,
        send: vi.fn(),
        close: vi.fn(),
      };
      return this.canal;
    }
    async createOffer() {
      return { type: "offer", sdp: "v=0 oferta" };
    }
    async setLocalDescription() {}
    async setRemoteDescription() {}
    addEventListener() {}
    removeEventListener() {}
    close() {}
  }

  class AudioWorkletNodeFalso {
    port = { onmessage: null, postMessage: vi.fn() };
    constructor(_ctx: unknown, nome: string) {
      worklets[nome] = this;
    }
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

function usuario(): AuthUser {
  return {
    id: EU,
    email: "quem@exemplo.com",
    full_name: "Quem Atende",
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR",
    organizations: [],
  } as AuthUser;
}

const org: ActiveOrg = { orgId: ORG, name: "Org de teste", role: "agent" };

function linhaConectada() {
  return {
    id: CHAMADA,
    contact_id: null,
    direction: "outbound",
    peer_phone: "+5511999998888",
    status: "connected",
    end_reason: null,
    started_at: new Date().toISOString(),
    answered_at: new Date().toISOString(),
    owner_user_id: EU,
    created_by: EU,
  };
}

/**
 * Deixa React e microtarefas assentarem sob timers falsos.
 *
 * `waitFor` não serve aqui: ele dorme, e o relógio é falso. `conectarMidia`
 * encadeia vários `await` (microfone, worklets, POST do SDP), então uma volta só
 * não basta — cada uma libera o próximo `await` da cadeia.
 */
async function assentar(voltas = 10) {
  for (let i = 0; i < voltas; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

/** Monta o hook, entrega uma chamada JÁ conectada e devolve o resultado. */
async function emLigacao() {
  const ref = { current: null };
  const vista = renderHook(() => useVoiceCallSession(ref), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <AuthProvider user={usuario()} activeOrg={org}>
        {children}
      </AuthProvider>
    ),
  });
  await assentar();
  await act(async () => {
    espiao.onChange?.({ new: linhaConectada() });
  });
  await assentar();
  return vista;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  instalarDublesDoNavegador();
  espiao.get.mockResolvedValue({ data: [] });
  espiao.post.mockResolvedValue({ data: { sdpAnswer: "v=0 resposta" } });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("o painel só diz que há áudio quando a mídia abriu de verdade", () => {
  it("a chamada conectada no banco, sozinha, não é prova de áudio", async () => {
    const { result } = await emLigacao();

    // A linha existe, o cronômetro do painel já correria — e o transporte
    // ainda não abriu nada. É exatamente o silêncio que passava por sucesso.
    expect(result.current.call?.status).toBe("connected");
    expect(conexao).not.toBeNull();
    expect(conexao?.canal.label).toBe("pcm");
    expect(result.current.estadoDaMidia).toBe("negociando");
  });

  it("o canal `pcm` abrindo prova a rota — ICE, DTLS e SCTP tiveram de fechar", async () => {
    const { result } = await emLigacao();
    await act(async () => {
      conexao!.canal.readyState = "open";
      conexao!.canal.onopen?.();
    });
    expect(result.current.estadoDaMidia).toBe("aberta");
  });

  it("o primeiro quadro de PCM é a prova de que há SOM, não só rota", async () => {
    const { result } = await emLigacao();
    await act(async () => {
      conexao!.canal.readyState = "open";
      conexao!.canal.onopen?.();
    });
    await act(async () => {
      conexao!.canal.onmessage?.({ data: new ArrayBuffer(256) });
    });
    expect(result.current.estadoDaMidia).toBe("com_audio");
  });

  it("ICE falhando vira `sem_rota` na hora, sem esperar prazo nenhum", async () => {
    const { result } = await emLigacao();
    await act(async () => {
      conexao!.connectionState = "failed";
      conexao!.onconnectionstatechange?.();
    });
    expect(result.current.estadoDaMidia).toBe("sem_rota");
  });

  it("canal que nunca abre deixa de ficar eternamente em `negociando`", async () => {
    const { result } = await emLigacao();
    expect(result.current.estadoDaMidia).toBe("negociando");

    // 11s: ainda dentro do prazo. O painel não pode gritar cedo demais.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(11_000);
    });
    expect(result.current.estadoDaMidia).toBe("negociando");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(result.current.estadoDaMidia).toBe("sem_rota");
  });

  it("o prazo não atropela um canal que abriu antes dele", async () => {
    const { result } = await emLigacao();
    await act(async () => {
      conexao!.canal.readyState = "open";
      conexao!.canal.onopen?.();
      conexao!.canal.onmessage?.({ data: new ArrayBuffer(256) });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(result.current.estadoDaMidia).toBe("com_audio");
  });

  it("reconexão devolve o estado: um soluço de rede não prende o painel em `sem_rota`", async () => {
    const { result } = await emLigacao();
    await act(async () => {
      conexao!.canal.readyState = "open";
      conexao!.canal.onopen?.();
      conexao!.canal.onmessage?.({ data: new ArrayBuffer(256) });
    });
    await act(async () => {
      conexao!.connectionState = "disconnected";
      conexao!.onconnectionstatechange?.();
    });
    expect(result.current.estadoDaMidia).toBe("sem_rota");

    // `dc.onopen` NÃO dispara de novo num canal que já abriu — quem devolve o
    // estado é a volta por `connectionState`.
    await act(async () => {
      conexao!.connectionState = "connected";
      conexao!.onconnectionstatechange?.();
    });
    expect(result.current.estadoDaMidia).toBe("com_audio");
  });

  it("a contabilidade do estado não engole áudio: todo quadro chega ao playback", async () => {
    // O risco real de pendurar contabilidade no caminho do áudio é alguém
    // "otimizar" com um early-return depois do primeiro quadro — a ligação
    // emudeceria com o painel dizendo `com_audio`, que é a mesma falha-em-verde
    // de volta, uma camada mais fundo. `dc.onmessage` dispara ~125x/s: ele é
    // caminho de MÍDIA, e o estado é carona.
    await emLigacao();
    await act(async () => {
      conexao!.canal.readyState = "open";
      conexao!.canal.onopen?.();
    });
    await act(async () => {
      for (let i = 0; i < 500; i++) conexao!.canal.onmessage?.({ data: new ArrayBuffer(256) });
    });
    expect(worklets["playback-processor"]?.port.postMessage).toHaveBeenCalledTimes(500);
  });

  it("encerrar a chamada devolve a mídia a `ociosa`", async () => {
    const { result } = await emLigacao();
    await act(async () => {
      conexao!.canal.readyState = "open";
      conexao!.canal.onopen?.();
    });
    await act(async () => {
      espiao.onChange?.({ new: { ...linhaConectada(), status: "ended" } });
    });
    await assentar();
    expect(result.current.estadoDaMidia).toBe("ociosa");
  });
});
