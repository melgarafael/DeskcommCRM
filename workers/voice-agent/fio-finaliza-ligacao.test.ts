/**
 * O ÚLTIMO ELO: `finalizeAudioSocketCall` (index.ts) leva a soma da ponte para
 * `llm_calls`. Os casos de `fio-uso-da-sessao.test.ts` provam a ponte e a linha
 * pura, mas não que o fim da ligação as grava: desligar a chamada a
 * `registrarChamadaDeIa` deixava todos verdes (medido na triagem do #2583).
 *
 * Aqui a ligação passa pelo caminho real — `handleAudioSocketConnection` monta a
 * ponte, a ponte avisa o fim (`onCallEnded`), e `finalizeAudioSocketCall` roda
 * de verdade. A ponte é um dublê só para não abrir WebSocket com a OpenAI.
 */
import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  aoEncerrar: null as null | (() => Promise<void> | void),
  registradas: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      const consulta = {
        select: () => consulta,
        update: () => consulta,
        eq: () => consulta,
        single: async () => ({
          data: { id: "chamada-1", organization_id: "org-1", contact_id: "contato-1" },
          error: null,
        }),
        maybeSingle: async () => ({ data: { status: "active" }, error: null }),
        then: (ok: (r: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(ok),
      };
      void tabela;
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
  getActiveVoiceAgent: async () => ({ id: "agente-1", systemPrompt: "", voice: "alloy", apiKey: "k" }),
}));
vi.mock("@/lib/ai/knowledge/busca", () => ({
  buscarConhecimento: async () => ({ trechos: [] }),
  resolverAcervoDoAgente: async () => [],
}));
vi.mock("@/lib/organizacao/operante", () => ({ ehOperante: () => true }));
vi.mock("@/lib/ai/usage/registrar-chamada", () => ({
  registrarChamadaDeIa: async (_admin: unknown, linha: Record<string, unknown>) => {
    fakes.registradas.push(linha);
  },
}));
vi.mock("./audioSocketBridge", () => ({
  AudioSocketCallBridge: class {
    constructor(_socket: unknown, ctx: { onCallEnded: () => Promise<void> | void }) {
      fakes.aoEncerrar = ctx.onCallEnded;
    }
    usoDaSessao() {
      return {
        modelo: "gpt-realtime",
        uso: {
          respostas: 1, entrada: 250, saida: 80,
          entradaAudio: 200, entradaTexto: 50, entradaCache: 0, saidaAudio: 70, saidaTexto: 10,
        },
        erro: null,
      };
    }
  },
}));

import { handleAudioSocketConnection } from "./index";

beforeEach(() => {
  fakes.aoEncerrar = null;
  fakes.registradas = [];
});

describe("finalizeAudioSocketCall grava o uso da ligação", () => {
  it("o fim da ligação grava UMA linha em llm_calls, com os tokens e custo nulo", async () => {
    const socket = new EventEmitter() as EventEmitter & { end: () => void };
    socket.end = vi.fn();
    await handleAudioSocketConnection(socket as never, "uuid-1", Buffer.alloc(0));
    expect(fakes.aoEncerrar).not.toBeNull();

    await fakes.aoEncerrar!();

    expect(fakes.registradas).toHaveLength(1);
    expect(fakes.registradas[0]).toMatchObject({
      organization_id: "org-1",
      model: "gpt-realtime",
      input_tokens: 250,
      output_tokens: 80,
      cost_cents: null,
    });
  });
});
