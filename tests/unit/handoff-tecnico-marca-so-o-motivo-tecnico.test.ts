import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #2210 / #2217 — a marca `handoff_tecnico` é do handoff cuja CAUSA é a mídia
 * ilegível, e só dele.
 *
 * A ferramenta `request_human_handoff` é a mesma para todos os motivos do
 * modelo, o pedido explícito do lead incluído. Olhar só a derivação do gatilho
 * marcava também o lead que escreveu "quero falar com um atendente" no mesmo
 * lote de um áudio ainda sem transcrição: o gatilho era o áudio, o motivo era o
 * pedido, e a marca devolvia a conversa ao agente quando a transcrição chegava.
 *
 * O teste dirige `applyRequestHumanHandoff` (a borda que a ferramenta chama) e
 * lê o UPDATE da conversa: o 6º parâmetro é a marca, e `{}` é "sem marca".
 */

vi.mock("@/lib/atendimento/fronteira-server", () => ({ guardServiceEffect: vi.fn(async () => {}) }));
vi.mock("@/lib/escalacao/disponibilidade", () => ({
  expectativaDeAtendimento: vi.fn(async () => ({ frase: "Uma pessoa vai responder." })),
}));
vi.mock("@/lib/leads/agent-activity", () => ({ emitAgentActivityForContact: vi.fn(async () => true) }));
vi.mock("@/lib/agent-engine/cron/scheduler", () => ({ cancelPendingCronsForLead: vi.fn(async () => {}) }));

import { applyRequestHumanHandoff } from "@/lib/agent-engine/agent/human-handoff";

const consultas: Array<{ sql: string; params: unknown[] }> = [];

/** Pool dublê: o áudio do gatilho está com a derivação ABERTA. */
const db = {
  query: vi.fn(async (sql: string, params: unknown[] = []) => {
    consultas.push({ sql, params });
    if (/select media_url, media_derived_status/.test(sql)) {
      return { rows: [{ media_url: "https://waha/audio.ogg", media_derived_status: "pending" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }),
};

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log };

async function passar(pendentesDoCliente: string[]): Promise<Record<string, unknown>> {
  const r = await applyRequestHumanHandoff(
    db as never,
    { tenantId: "org1", leadId: "cont1", conversationId: "conv1" },
    {
      conversationSummary: "resumo",
      contextoDoTurno: { checkpoint: null, pendentesDoCliente },
      avisoAoLead: { avisado: true },
      gatilho: { inboundMessageId: "msg-audio" },
      log: log as never,
    },
    { por_que: "o cliente quer falar com uma pessoa" },
  );
  expect(r.ok).toBe(true);
  const update = consultas.find((c) => /update conversations/.test(c.sql) && /bot_silenced_until/.test(c.sql));
  expect(update, "o handoff não gravou a conversa").toBeTruthy();
  return JSON.parse(String(update!.params[5])) as Record<string, unknown>;
}

describe("a marca do handoff técnico só sai quando a causa é a falta de texto (#2210)", () => {
  beforeEach(() => {
    consultas.length = 0;
    db.query.mockClear();
  });

  it("pedido explícito em texto no mesmo lote do áudio pendente: NÃO marca", async () => {
    const marca = await passar(["quero falar com um atendente", "[audio]"]);
    expect(marca, "o pedido do lead seria desfeito quando a transcrição chegasse").toEqual({});
  });

  it("qualquer outra palavra do cliente no turno também NÃO marca", async () => {
    expect(await passar(["[audio]", "vocês aceitam cartão?"])).toEqual({});
  });

  it("sem saber o que o cliente disse (lista vazia): NÃO marca", async () => {
    expect(await passar([])).toEqual({});
  });

  it("só mídia ilegível no turno: marca — controle de que a sonda está viva", async () => {
    const marca = await passar(["[audio]", "[audio]"]);
    expect(marca).toMatchObject({
      handoff_tecnico: {
        causa: "derivacao_ausente",
        message_id: "msg-audio",
        motivo_gravado: "o cliente quer falar com uma pessoa",
      },
    });
    // `marcado_em` é carimbado pelo banco no UPDATE, não pelo relógio do Node.
    expect((marca.handoff_tecnico as Record<string, unknown>).marcado_em).toBeUndefined();
  });
});
