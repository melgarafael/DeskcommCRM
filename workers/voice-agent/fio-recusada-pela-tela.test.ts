/**
 * TESTE DO FIO: ligação SIP recusada pela tela não é atendida pela IA.
 *
 * A recusa (`lib/voip/recusar-chamada-sip.ts`) só grava a linha `ended`: o app
 * não fala com o Asterisk. Quem derruba o canal é este worker, quando o
 * AudioSocket conecta e encontra a linha encerrada. Sem a guarda, a IA abria a
 * sessão paga e regravava a linha como `connected` — a recusa virava atendimento.
 *
 * SABOTAGEM DO FIO: remover o bloco `if (callRow.status === "ended")` em
 * `handleAudioSocketConnection` = o caso "recusada" fica vermelho.
 */
import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  status: "ringing" as string,
  updates: [] as Array<Record<string, unknown>>,
  wsAbertos: 0,
}));

vi.mock("ws", async () => {
  const { EventEmitter: Emissor } = await import("node:events");
  class FakeWs extends Emissor {
    static OPEN = 1;
    readyState = 1;
    send = vi.fn();
    close = vi.fn();
    constructor() {
      super();
      fakes.wsAbertos += 1;
    }
  }
  return { default: FakeWs };
});

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => {
      const consulta = {
        select: () => consulta,
        update: (m: Record<string, unknown>) => {
          fakes.updates.push(m);
          return consulta;
        },
        eq: () => consulta,
        in: () => consulta,
        single: async () => ({
          data: {
            id: "chamada-1",
            organization_id: "org-1",
            contact_id: null,
            direction: "inbound",
            status: fakes.status,
            end_reason: fakes.status === "ended" ? "declined" : null,
          },
          error: null,
        }),
        maybeSingle: async () => ({ data: { status: "active" }, error: null }),
        then: (ok: (r: unknown) => unknown) => Promise.resolve({ data: [{ id: "chamada-1" }], error: null }).then(ok),
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
  getActiveVoiceAgent: async () => ({ id: "agente-1", systemPrompt: "Você é a Ana.", voice: "marin", voiceSpeed: 1, apiKey: "k" }),
}));
vi.mock("@/lib/ai/knowledge/busca", () => ({
  buscarConhecimento: async () => ({ trechos: [] }),
  resolverAcervoDoAgente: async () => [],
}));
vi.mock("@/lib/organizacao/operante", () => ({ ehOperante: () => true }));
vi.mock("@/lib/ai/usage/registrar-chamada", () => ({ registrarChamadaDeIa: async () => undefined }));

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

beforeEach(() => {
  fakes.updates = [];
  fakes.wsAbertos = 0;
});

describe("AudioSocket de ligação recusada pela tela", () => {
  it("recusada (linha ended): fecha o socket, não abre a IA nem regrava a linha", async () => {
    fakes.status = "ended";
    const socket = socketDeBrinquedo();
    await handleAudioSocketConnection(socket as never, "uuid-1", Buffer.alloc(0));

    expect(socket.end).toHaveBeenCalledTimes(1);
    expect(fakes.wsAbertos).toBe(0);
    expect(fakes.updates).toEqual([]);
  });

  it("controle: tocando, a IA atende e a linha vira connected", async () => {
    fakes.status = "ringing";
    const socket = socketDeBrinquedo();
    await handleAudioSocketConnection(socket as never, "uuid-1", Buffer.alloc(0));

    expect(socket.end).not.toHaveBeenCalled();
    expect(fakes.wsAbertos).toBe(1);
    expect(fakes.updates).toContainEqual(expect.objectContaining({ status: "connected", handled_by: "ai" }));
    socket.emit("close");
  });
});
