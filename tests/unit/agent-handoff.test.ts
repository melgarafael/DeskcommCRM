/**
 * Handoff explícito IA → IA (Entrega 6 do plano de concierge de compras
 * Magento) — `lib/agent-engine/agent/agent-handoff.ts`. Cobre: recusa de
 * autotransferência, destino fora da whitelist, destino não publicado,
 * cadeia esgotada, ping-pong imediato (A→B→A), efetivação com sucesso
 * (grava handoff + muda posse + enfileira continuação) e replay idempotente
 * do mesmo turno (job_id repetido).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";

import type { PublishedAgentConfig } from "@/lib/agent-engine/agent/agent-config";
import type * as AgentConfigModule from "@/lib/agent-engine/agent/agent-config";
import type * as QueueModule from "@/lib/agent-engine/queue/queue";
import type { Logger } from "@/lib/agent-engine/obs/logger";

const loadPublishedAgentConfigByIdMock = vi.fn();
vi.mock("@/lib/agent-engine/agent/agent-config", async () => {
  const actual = await vi.importActual<typeof AgentConfigModule>("@/lib/agent-engine/agent/agent-config");
  return { ...actual, loadPublishedAgentConfigById: loadPublishedAgentConfigByIdMock };
});

const enqueueJobMock = vi.fn(async (..._args: unknown[]) => ({ job: { id: "job-2" }, deduped: false }));
vi.mock("@/lib/agent-engine/queue/queue", async () => {
  const actual = await vi.importActual<typeof QueueModule>("@/lib/agent-engine/queue/queue");
  return { ...actual, enqueueJob: enqueueJobMock };
});

const { applyRequestAgentHandoff } = await import("@/lib/agent-engine/agent/agent-handoff");

const FROM_AGENT = {
  agentId: "11111111-1111-4111-8111-111111111111",
  versionId: "55555555-5555-4555-8555-555555555555",
  agentName: "Concierge",
  handoffTargets: ["22222222-2222-4222-8222-222222222222"],
} as unknown as PublishedAgentConfig;

const TO_AGENT = {
  agentId: "22222222-2222-4222-8222-222222222222",
  versionId: "66666666-6666-4666-8666-666666666666",
  agentName: "Assistente de carrinho",
} as unknown as PublishedAgentConfig;

const IDS = { tenantId: "org-1", conversationId: "conv-1", leadId: "lead-1", jobId: "job-1" };
const LOG = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;

interface Handoff {
  chain_position: number;
  from_agent_id: string | null;
}

function makePool(opts: { lastHandoff?: Handoff; insertConflict?: boolean } = {}): pg.Pool {
  const query = vi.fn(async (sql: string) => {
    if (/select chain_position, from_agent_id from ai_agent_handoffs/.test(sql)) {
      return { rows: opts.lastHandoff ? [opts.lastHandoff] : [] };
    }
    if (/insert into ai_agent_handoffs/.test(sql)) {
      if (opts.insertConflict) {
        const err = Object.assign(new Error("duplicate"), { code: "23505" });
        throw err;
      }
      return { rows: [{ id: "handoff-1" }] };
    }
    return { rows: [] };
  });
  return { query } as unknown as pg.Pool;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("applyRequestAgentHandoff", () => {
  it("recusa transferir para o próprio agente", async () => {
    const pool = makePool();
    const res = await applyRequestAgentHandoff(
      pool,
      IDS,
      { agentConfig: FROM_AGENT },
      { log: LOG },
      { to_agent_id: "11111111-1111-4111-8111-111111111111", reason: "x", summary: "y" },
    );
    expect(res).toMatchObject({ ok: false, error: { code: "destino_invalido" } });
  });

  it("recusa destino fora da whitelist da versão publicada", async () => {
    const pool = makePool();
    const res = await applyRequestAgentHandoff(
      pool,
      IDS,
      { agentConfig: FROM_AGENT },
      { log: LOG },
      { to_agent_id: "33333333-3333-4333-8333-333333333333", reason: "x", summary: "y" },
    );
    expect(res).toMatchObject({ ok: false, error: { code: "destino_nao_permitido" } });
  });

  it("recusa destino não publicado", async () => {
    loadPublishedAgentConfigByIdMock.mockResolvedValue(null);
    const pool = makePool();
    const res = await applyRequestAgentHandoff(
      pool,
      IDS,
      { agentConfig: FROM_AGENT },
      { log: LOG },
      { to_agent_id: "22222222-2222-4222-8222-222222222222", reason: "x", summary: "y" },
    );
    expect(res).toMatchObject({ ok: false, error: { code: "destino_nao_publicado" } });
  });

  it("recusa cadeia esgotada", async () => {
    loadPublishedAgentConfigByIdMock.mockResolvedValue(TO_AGENT);
    const pool = makePool({ lastHandoff: { chain_position: 5, from_agent_id: "44444444-4444-4444-8444-444444444444" } });
    const res = await applyRequestAgentHandoff(
      pool,
      IDS,
      { agentConfig: FROM_AGENT },
      { log: LOG },
      { to_agent_id: "22222222-2222-4222-8222-222222222222", reason: "x", summary: "y" },
    );
    expect(res).toMatchObject({ ok: false, error: { code: "cadeia_esgotada" } });
  });

  it("recusa devolver a conversa para quem acabou de transferir (ping-pong imediato)", async () => {
    loadPublishedAgentConfigByIdMock.mockResolvedValue(TO_AGENT);
    const pool = makePool({ lastHandoff: { chain_position: 1, from_agent_id: "22222222-2222-4222-8222-222222222222" } });
    const res = await applyRequestAgentHandoff(
      pool,
      IDS,
      { agentConfig: FROM_AGENT },
      { log: LOG },
      { to_agent_id: "22222222-2222-4222-8222-222222222222", reason: "x", summary: "y" },
    );
    expect(res).toMatchObject({ ok: false, error: { code: "transferencia_circular" } });
  });

  it("efetiva a transferência: grava handoff, muda posse e enfileira a continuação", async () => {
    loadPublishedAgentConfigByIdMock.mockResolvedValue(TO_AGENT);
    const pool = makePool();
    const res = await applyRequestAgentHandoff(
      pool,
      IDS,
      { agentConfig: FROM_AGENT },
      { log: LOG },
      { to_agent_id: "22222222-2222-4222-8222-222222222222", reason: "seleção fechada", summary: "cliente quer 2 rolos da opção 2" },
    );
    expect(res).toMatchObject({ ok: true, status: "transferido", destino: "Assistente de carrinho" });
    expect(enqueueJobMock).toHaveBeenCalledTimes(1);
    const [, tenantIdArg, payloadArg] = enqueueJobMock.mock.calls[0]!;
    expect(tenantIdArg).toBe("org-1");
    expect(payloadArg).toMatchObject({
      leadId: "lead-1",
      kind: "followup_turn",
      sourceEventId: "handoff-1",
      payload: { context_snapshot: "cliente quer 2 rolos da opção 2" },
    });
  });

  it("replay do mesmo job (dedupe_key repetido) não duplica nem reenfileira", async () => {
    loadPublishedAgentConfigByIdMock.mockResolvedValue(TO_AGENT);
    const pool = makePool({ insertConflict: true });
    const res = await applyRequestAgentHandoff(
      pool,
      IDS,
      { agentConfig: FROM_AGENT },
      { log: LOG },
      { to_agent_id: "22222222-2222-4222-8222-222222222222", reason: "x", summary: "y" },
    );
    expect(res).toMatchObject({ ok: true, status: "transferido" });
    expect(enqueueJobMock).not.toHaveBeenCalled();
  });
});
