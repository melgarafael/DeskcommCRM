/**
 * Ligação RECEBIDA: a IA fala primeiro. Sem isto ela ficava calada até ouvir
 * voz, e quem ligava ouvia silêncio (medido ao vivo em 03/11/2026: 36 s e 12 s
 * até o cliente falar "alô"). Ligação FEITA por nós segue esperando o "alô".
 *
 * Duas metades, porque cada uma sozinha deixa a outra quebrar em silêncio:
 * - a ponte: com `falaPrimeiro`, manda `response.create` logo depois do
 *   `session.update` e ANTES do áudio acumulado; sem ele, não manda nada;
 * - o fio: `handleAudioSocketConnection` (index.ts) liga `falaPrimeiro` pela
 *   direção da linha de `voice_calls`.
 *
 * SABOTAGEM: tirar o `send(response.create)` da ponte derruba o caso "abre a
 * conversa"; trocar o `falaPrimeiro: callRow.direction === "inbound"` por
 * `true` derruba o caso "saída".
 */
import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  ultimoWs: null as (EventEmitter & { send: ReturnType<typeof vi.fn>; readyState: number }) | null,
  direcao: "inbound" as string,
}));

// WebSocket de brinquedo: nenhum byte sai para a OpenAI.
vi.mock("ws", async () => {
  const { EventEmitter: Emissor } = await import("node:events");
  class FakeWs extends Emissor {
    static OPEN = 1;
    readyState = 1;
    send = vi.fn();
    close = vi.fn();
    constructor() {
      super();
      fakes.ultimoWs = this as never;
    }
  }
  return { default: FakeWs };
});

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => {
      const consulta = {
        select: () => consulta,
        update: () => consulta,
        eq: () => consulta,
        in: () => consulta,
        single: async () => ({
          data: {
            id: "chamada-1",
            organization_id: "org-1",
            contact_id: "contato-1",
            direction: fakes.direcao,
          },
          error: null,
        }),
        maybeSingle: async () => ({ data: { status: "active" }, error: null }),
        then: (ok: (r: unknown) => unknown) =>
          Promise.resolve({ data: [{ id: "chamada-1" }], error: null }).then(ok),
      };
      return consulta;
    },
  }),
}));
vi.mock("@/lib/voip/ariClient", () => ({
  connectAriEvents: () => undefined,
  hangupChannel: () => undefined,
  setChannelVariable: () => undefined,
  continueDialplan: () => undefined,
}));
vi.mock("@/lib/ai/agents", () => ({
  getActiveVoiceAgent: async () => ({
    id: "agente-1",
    systemPrompt: "Você é a Ana, da Clínica Exemplo.",
    voice: "marin",
    voiceSpeed: 1,
    apiKey: "k",
  }),
}));
vi.mock("@/lib/ai/knowledge/busca", () => ({
  buscarConhecimento: async () => ({ trechos: [] }),
  resolverAcervoDoAgente: async () => [],
}));
vi.mock("@/lib/organizacao/operante", () => ({ ehOperante: () => true }));
vi.mock("@/lib/ai/usage/registrar-chamada", () => ({
  registrarChamadaDeIa: async () => undefined,
}));

import { AudioSocketCallBridge } from "./audioSocketBridge";
import { handleAudioSocketConnection } from "./index";

function socketDeBrinquedo() {
  const s = new EventEmitter() as EventEmitter & Record<string, unknown>;
  s.setNoDelay = vi.fn();
  s.write = vi.fn();
  s.end = vi.fn();
  s.destroy = vi.fn();
  s.destroyed = false;
  return s;
}

/** Os `type` enviados à OpenAI, na ordem. */
function enviados(): string[] {
  return fakes.ultimoWs!.send.mock.calls.map(
    (c) => (JSON.parse(c[0] as string) as { type: string }).type,
  );
}

/** Dispara o "open" do WebSocket e espera o handler assíncrono terminar. */
async function abrirSessao() {
  fakes.ultimoWs!.emit("open");
  await vi.waitFor(() => expect(enviados()).toContain("session.update"));
  await new Promise((r) => setTimeout(r, 0));
}

let ponte: AudioSocketCallBridge | null = null;
afterEach(() => {
  ponte?.close();
  ponte = null;
});
beforeEach(() => {
  fakes.ultimoWs = null;
  fakes.direcao = "inbound";
});

function abrirPonte(falaPrimeiro: boolean | undefined) {
  const socket = socketDeBrinquedo();
  ponte = new AudioSocketCallBridge(socket as never, {
    callId: "call1",
    organizationId: "org1",
    agentInstructions: "Você é a Ana.",
    voice: "marin",
    voiceSpeed: 1,
    voiceModel: "gpt-realtime",
    onTranscriptTurn: () => {},
    onCallEnded: () => {},
    knowledgeSourceIdsPromise: Promise.resolve([]),
    searchKnowledge: async () => ({ trechos: [] }),
    ...(falaPrimeiro === undefined ? {} : { falaPrimeiro }),
  });
  return socket;
}

describe("ponte de voz: quem fala primeiro", () => {
  it("ligação recebida: a IA abre a conversa logo depois do session.update, antes do áudio acumulado", async () => {
    const socket = abrirPonte(true);
    // Áudio do cliente que chega antes da sessão abrir (frame AudioSocket 0x10, 320 bytes).
    const frame = Buffer.concat([Buffer.from([0x10, 0x01, 0x40]), Buffer.alloc(320)]);
    socket.emit("data", frame);

    await abrirSessao();

    expect(enviados()).toEqual(["session.update", "response.create", "input_audio_buffer.append"]);
    const sessao = JSON.parse(fakes.ultimoWs!.send.mock.calls[0]![0] as string) as {
      session: { instructions: string };
    };
    expect(sessao.session.instructions).toMatch(/^Você é a Ana\./);
    expect(sessao.session.instructions).toContain("Fale primeiro");
  });

  it("sem falaPrimeiro: espera o cliente, nada de response.create nem da instrução de abertura", async () => {
    abrirPonte(undefined);
    await abrirSessao();

    expect(enviados()).toEqual(["session.update"]);
    const sessao = JSON.parse(fakes.ultimoWs!.send.mock.calls[0]![0] as string) as {
      session: { instructions: string };
    };
    expect(sessao.session.instructions).not.toContain("Fale primeiro");
  });
});

describe("o fio: a direção da chamada decide", () => {
  async function conectar() {
    const socket = socketDeBrinquedo();
    await handleAudioSocketConnection(socket as never, "uuid-1", Buffer.alloc(0));
    await abrirSessao();
    return enviados();
  }

  it("entrada (inbound): a IA abre a conversa", async () => {
    fakes.direcao = "inbound";
    expect(await conectar()).toContain("response.create");
  });

  it('saída (outbound): espera o "alô" de quem atende', async () => {
    fakes.direcao = "outbound";
    expect(await conectar()).not.toContain("response.create");
  });
});
