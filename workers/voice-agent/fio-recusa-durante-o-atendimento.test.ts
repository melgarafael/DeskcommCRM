/**
 * TESTE DO FIO: a recusa pela tela que chega NO INSTANTE do atendimento vale.
 *
 * O worker lê a linha (`ringing`), passa por várias idas ao banco (organização,
 * agente de voz, acervo) e só então grava `connected`. Se a recusa
 * (recusarChamadaSip) grava `ended`/`declined` nesse meio, o `connected` não pode
 * sobrescrevê-la: a tela já recebeu 200 e a recusa já foi auditada.
 *
 * SABOTAGEM: tirar o `.in("status", ["starting","ringing"])` do update `connected`
 * em handleAudioSocketConnection deixa este caso vermelho — a linha final vira
 * {status:"connected", end_reason:"declined"} e o socket não é fechado.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  linha: { status: "ringing", end_reason: null as string | null } as Record<string, unknown>,
}));

vi.mock("ws", async () => {
  const { EventEmitter: E } = await import("node:events");
  class FakeWs extends E {
    static OPEN = 1;
    readyState = 1;
    send = vi.fn();
    close = vi.fn();
  }
  return { default: FakeWs };
});
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => {
      let mudanca: Record<string, unknown> | null = null;
      const consulta: Record<string, unknown> = {
        select: () => consulta,
        update: (m: Record<string, unknown>) => {
          mudanca = m;
          return consulta;
        },
        eq: () => consulta,
        in: (_coluna: string, valores: unknown[]) => {
          if (mudanca && !valores.includes(fakes.linha.status)) mudanca = null;
          return consulta;
        },
        single: async () => ({
          data: { id: "chamada-1", organization_id: "org-1", contact_id: null, direction: "inbound", ...fakes.linha },
          error: null,
        }),
        maybeSingle: async () => ({ data: { status: "active" }, error: null }),
        then: (ok: (r: unknown) => unknown) => {
          const gravou = mudanca !== null;
          if (mudanca) Object.assign(fakes.linha, mudanca);
          return Promise.resolve({ data: gravou ? [{ id: "chamada-1" }] : [], error: null }).then(ok);
        },
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
  getActiveVoiceAgent: async () => {
    // a recusa pela tela grava AGORA, entre a leitura da linha e o `connected`
    Object.assign(fakes.linha, { status: "ended", end_reason: "declined" });
    return { id: "agente-1", systemPrompt: "x", voice: "marin", voiceSpeed: 1, apiKey: "k" };
  },
}));
vi.mock("@/lib/ai/knowledge/busca", () => ({
  buscarConhecimento: async () => ({ trechos: [] }),
  resolverAcervoDoAgente: async () => [],
}));
vi.mock("@/lib/organizacao/operante", () => ({ ehOperante: () => true }));
vi.mock("@/lib/ai/usage/registrar-chamada", () => ({ registrarChamadaDeIa: async () => undefined }));

import { handleAudioSocketConnection } from "./index";

describe("recusa que chega durante o atendimento", () => {
  it("a linha recusada continua recusada e o worker desliga", async () => {
    const socket = new EventEmitter() as EventEmitter & Record<string, unknown>;
    Object.assign(socket, { setNoDelay: vi.fn(), write: vi.fn(), end: vi.fn(), destroy: vi.fn(), destroyed: false });

    await handleAudioSocketConnection(socket as never, "uuid-1", Buffer.alloc(0));

    expect(fakes.linha).toMatchObject({ status: "ended", end_reason: "declined" });
    expect(fakes.linha).not.toHaveProperty("handled_by");
    expect(socket.end).toHaveBeenCalled();
    socket.emit("close");
  });
});
