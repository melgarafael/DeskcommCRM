/**
 * A COLA de `sendTurnMessage` com a voz — não a idempotência (já provada em
 * `resolver-caminho-de-voz.test.ts`) nem o ledger de texto (já provado em
 * `followup-send-ledger.test.ts`). Aqui: dado que `input.voz` existe, o
 * payload que chega a `sendMessageHandler` é `type:'audio'` com o path
 * resolvido, `ctx.aiVoiceDerivedText` carrega o texto original, e um
 * desfecho TERMINAL da síntese (`already_sent`/`blocked`) nunca chega a
 * tentar enviar nada.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

// `vi.mock` é içado para o topo do arquivo — referenciar uma const comum
// declarada DEPOIS dispararia "Cannot access before initialization". `vi.hoisted`
// é o escape oficial: o que está dentro dele é içado JUNTO com o `vi.mock`.
const { sendMessageHandlerMock, resolverCaminhoDeVozMock, registrarCustoDeVozMock } = vi.hoisted(() => ({
  sendMessageHandlerMock: vi.fn(),
  resolverCaminhoDeVozMock: vi.fn(),
  registrarCustoDeVozMock: vi.fn(),
}));

vi.mock("@/app/api/v1/messages/_handler", () => ({
  sendMessageHandler: sendMessageHandlerMock,
}));

vi.mock("@/lib/agent-engine/edge/crm/send-voice", () => ({
  resolverCaminhoDeVoz: resolverCaminhoDeVozMock,
  registrarCustoDeVoz: registrarCustoDeVozMock,
  VozLedgerTerminalError: class VozLedgerTerminalError extends Error {
    constructor(
      public readonly kind: "already_sent" | "blocked",
      public readonly key: string,
      public readonly crmMessageId: string | null,
    ) {
      super(`síntese de voz recusada: a linha do ledger já está '${kind}'`);
      this.name = "VozLedgerTerminalError";
    }
  },
}));

import { sendTurnMessage, type SendMessageInput } from "@/lib/agent-engine/edge/crm/send-message";
import { VozLedgerTerminalError } from "@/lib/agent-engine/edge/crm/send-voice";

// `requireCurrentServiceBoundary` recusa QUALQUER job sem fronteira — é
// `!expected` sozinho que dispara `StaleServiceBoundaryError`
// (`lib/atendimento/fronteira.ts`), então todo job de produção que chega a
// `sendTurnMessage` carrega uma. A fronteira "atual" (lida do banco) precisa
// bater com a do payload do job para passar a checagem.
const FRONTEIRA = {
  organization_id: "org1",
  contact_id: "contact1",
  conversation_id: "conv1",
  service_revision: 1,
  demanda_id: null,
  demanda_revision: null,
};

function dbComJob(payload: Record<string, unknown> = {}, kind = "agent_turn") {
  return {
    query: vi.fn(async (text: string) => {
      if (text.includes("from job_queue")) {
        return { rows: [{ kind, payload: { service_boundary: FRONTEIRA, ...payload } }], rowCount: 1 } as never;
      }
      if (text.includes("insert into send_ledger")) {
        return { rows: [{ id: "ledger-key-1" }], rowCount: 1 } as never;
      }
      if (text.includes("from messages")) {
        // Nenhuma mensagem com esta idempotency_key ainda — é o que faz
        // `sendWithLedger` de fato chamar o `send()` (que é quem monta o
        // payload pra `sendMessageHandler`, o que este arquivo testa).
        return { rows: [], rowCount: 0 } as never;
      }
      // A única outra query deste caminho é a leitura da fronteira atual.
      return {
        rows: [{ ...FRONTEIRA, status: "open", demanda_fechada_em: null }],
        rowCount: 1,
      } as never;
    }),
  };
}

const cfg = { supabase: {} as never };

const baseInput: SendMessageInput = {
  tenantId: "org1",
  leadId: "contact1",
  jobId: "job1",
  seq: 1,
  conversationId: "conv1",
  body: "texto falado já limpo",
};

beforeEach(() => {
  sendMessageHandlerMock.mockReset();
  resolverCaminhoDeVozMock.mockReset();
  registrarCustoDeVozMock.mockReset();
});

describe("sendTurnMessage — voz (Fase 6a)", () => {
  it("sem input.voz: comportamento de texto, resolverCaminhoDeVoz nunca é chamado", async () => {
    sendMessageHandlerMock.mockResolvedValue({ id: "msg1", status: "sent" });
    // sendWithLedger real exigiria mockar o ledger inteiro — fora do escopo
    // deste arquivo (ver followup-send-ledger.test.ts). Aqui só confere que o
    // branch de voz foi CORRETAMENTE ignorado antes de chegar lá, então o erro
    // (db sem suporte a send_ledger) é aceitável e não é o que se testa.
    const db = dbComJob();
    await sendTurnMessage(db, cfg, baseInput).catch(() => {});
    expect(resolverCaminhoDeVozMock).not.toHaveBeenCalled();
  });

  it("com input.voz resolvido: payload é type:'audio' com o path, e aiVoiceDerivedText carrega o original", async () => {
    resolverCaminhoDeVozMock.mockResolvedValue({
      mediaStoragePath: "org1/conv1/voz-agente-job1-1.mp3",
      mimeType: "audio/mpeg",
      caracteres: 20,
      sintetizouAgora: true,
    });
    sendMessageHandlerMock.mockResolvedValue({ id: "msg1", status: "sent" });
    const db = dbComJob();
    const upload = vi.fn(async () => "org1/conv1/voz-agente-job1-1.mp3");

    await sendTurnMessage(db, cfg, {
      ...baseInput,
      voz: { textoOriginal: "Texto original 🎉", apiKey: "sk", voiceId: "v1", upload },
    });

    expect(resolverCaminhoDeVozMock).toHaveBeenCalledWith(
      expect.objectContaining({
        identidade: { tenantId: "org1", leadId: "contact1", jobId: "job1", seq: 1 },
        textoFalado: "texto falado já limpo",
        voz: { apiKey: "sk", voiceId: "v1", modelId: undefined },
        upload,
      }),
    );
    expect(sendMessageHandlerMock).toHaveBeenCalledTimes(1);
    const [, ctx, payload] = sendMessageHandlerMock.mock.calls[0]!;
    expect(payload.type).toBe("audio");
    expect(payload.media_storage_path).toBe("org1/conv1/voz-agente-job1-1.mp3");
    expect(payload.media_mime).toBe("audio/mpeg");
    expect(ctx.aiVoiceDerivedText).toBe("Texto original 🎉");

    // sintetizouAgora:true — a chamada ao ElevenLabs de fato aconteceu agora,
    // então o custo precisa entrar no orçamento. `jobId` incluso: achado na
    // revisão — sem ele o rollup de custo POR EXECUÇÃO nunca via esta linha.
    expect(registrarCustoDeVozMock).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org1", jobId: "job1", caracteres: 20 }),
    );
  });

  it("retry que REUSOU o path (sintetizouAgora:false): NÃO registra custo de novo", async () => {
    resolverCaminhoDeVozMock.mockResolvedValue({
      mediaStoragePath: "org1/conv1/voz-agente-job1-1.mp3",
      mimeType: "audio/mpeg",
      caracteres: 20,
      sintetizouAgora: false,
    });
    sendMessageHandlerMock.mockResolvedValue({ id: "msg1", status: "sent" });
    const db = dbComJob();
    await sendTurnMessage(db, cfg, {
      ...baseInput,
      voz: { textoOriginal: "x", apiKey: "sk", voiceId: "v1", upload: vi.fn() },
    });
    expect(registrarCustoDeVozMock).not.toHaveBeenCalled();
  });

  it("síntese recusada por desfecho already_sent: NUNCA chama sendMessageHandler", async () => {
    resolverCaminhoDeVozMock.mockRejectedValue(
      new VozLedgerTerminalError("already_sent", "ledger-1", "msg-antiga"),
    );
    const db = dbComJob();
    const r = await sendTurnMessage(db, cfg, {
      ...baseInput,
      voz: { textoOriginal: "x", apiKey: "sk", voiceId: "v1", upload: vi.fn() },
    });
    expect(r).toEqual({ kind: "already_sent", idempotencyKey: "ledger-1", crmMessageId: "msg-antiga" });
    expect(sendMessageHandlerMock).not.toHaveBeenCalled();
  });

  it("síntese recusada por desfecho blocked (opt-out): NUNCA chama sendMessageHandler", async () => {
    resolverCaminhoDeVozMock.mockRejectedValue(
      new VozLedgerTerminalError("blocked", "ledger-1", null),
    );
    const db = dbComJob();
    const r = await sendTurnMessage(db, cfg, {
      ...baseInput,
      voz: { textoOriginal: "x", apiKey: "sk", voiceId: "v1", upload: vi.fn() },
    });
    expect(r).toEqual({ kind: "blocked", idempotencyKey: "ledger-1" });
    expect(sendMessageHandlerMock).not.toHaveBeenCalled();
  });

  it("erro de síntese que NÃO é terminal (ex.: ElevenLabs fora do ar) NÃO derruba o turno — cai pra texto", async () => {
    // Achado na revisão de código, antes da Fase 7: isto ERA `rejects.toThrow`
    // — uma falha do ElevenLabs/Storage matava o turno inteiro, e o cliente
    // não recebia resposta nenhuma. Voz é um EXTRA sobre um caminho que já
    // funciona (doutrina de voz-do-turno.ts); o teste agora prova isso aqui
    // também, não só na resolução de credencial.
    resolverCaminhoDeVozMock.mockRejectedValue(new Error("synthesis_503"));
    sendMessageHandlerMock.mockResolvedValue({ id: "msg1", status: "sent" });
    const db = dbComJob();

    await sendTurnMessage(db, cfg, {
      ...baseInput,
      voz: { textoOriginal: "x", apiKey: "sk", voiceId: "v1", upload: vi.fn() },
    });

    expect(sendMessageHandlerMock).toHaveBeenCalledTimes(1);
    const [, , payload] = sendMessageHandlerMock.mock.calls[0]!;
    // Sem `vozResolvida`, o caminho é EXATAMENTE o de texto normal — o corpo
    // que sai é `input.body` (o texto falado, já limpo), não media_storage_path.
    expect(payload.type).toBe("text");
    expect(payload.body).toBe("texto falado já limpo");
    expect(payload.media_storage_path).toBeUndefined();
    expect(registrarCustoDeVozMock).not.toHaveBeenCalled();
  });
});
