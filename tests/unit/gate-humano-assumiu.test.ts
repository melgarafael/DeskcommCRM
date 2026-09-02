/**
 * Bug crítico achado ao comparar com o changelog do upstream (DeskcommCRM 1.5.0):
 * quando um atendente humano clica "Assumir" numa conversa, a IA podia continuar
 * respondendo em paralelo — os dois respondiam o mesmo cliente ao mesmo tempo.
 *
 * Causa raiz: `stopGate` (1º gate da cadeia `before_send`, veto irrevogável) só
 * lia `contacts.is_blocked`/`force_human`, nunca `conversations.assignee_kind`.
 * Um humano que assumisse a conversa sem passar pelo fluxo de handoff explícito
 * (que seta `force_human`) não silenciava a IA em lugar nenhum: nem no início do
 * turno, nem no gate final antes do envio físico.
 *
 * O fix relê `conversations.assignee_kind` FRESCO, sob o mesmo advisory lock que
 * já serializa pacing/spinning (ver cabeçalho de `before-send.ts`) — é o mesmo
 * padrão que `readStopFlags`/`readLastInboundAt` já usam. Cobre a race: mesmo que
 * o turno tenha começado antes do "Assumir", o envio final vê o estado atual.
 */
import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  runBeforeSend,
  stopGate,
  type GateContext,
} from "@/lib/agent-engine/guardrails/before-send";
import { PACING_DEFAULTS } from "@/lib/agent-engine/pacing/defaults";
import { SPINNING_DEFAULTS } from "@/lib/agent-engine/spinning/defaults";
import type { Logger } from "@/lib/agent-engine/obs/logger";

const AGORA = new Date("2026-07-28T13:00:00Z"); // 10h BRT, terça — dentro da janela comercial

function baseCtx(overrides: Partial<GateContext> = {}): GateContext {
  return {
    now: AGORA,
    body: "oi",
    optedOut: false,
    provider: "waha",
    pacing: {
      knobs: PACING_DEFAULTS,
      state: { lastSentAt: null, sentToday: 0, numberActivatedAt: null },
      crmDailyLimit: null,
      rng: () => 0,
    },
    spinning: { knobs: SPINNING_DEFAULTS, window: [] },
    promise: { table: null },
    semanticPromise: null,
    disclosure: { template: null, isFirstOutbound: false, mode: "inject" },
    lgpd: null,
    casesEnabled: false,
    hasOpenCase: false,
    openedCaseThisTurn: false,
    ...overrides,
  };
}

describe("stopGate veta quando um humano assumiu a conversa", () => {
  it("humanAssigned=true veta com código próprio, mesmo sem optedOut", () => {
    const v = stopGate.evaluate(baseCtx({ humanAssigned: true }));
    expect(v.pass).toBe(false);
    if (v.pass) throw new Error("inalcançável");
    expect(v.code).toBe("assumido_por_humano");
  });

  it("humanAssigned=false e optedOut=false: passa normalmente", () => {
    const v = stopGate.evaluate(baseCtx());
    expect(v.pass).toBe(true);
  });

  it("optedOut continua vetando quando humanAssigned é false (não regride o veto existente)", () => {
    const v = stopGate.evaluate(baseCtx({ optedOut: true }));
    expect(v.pass).toBe(false);
    if (v.pass) throw new Error("inalcançável");
    expect(v.code).toBe("contato_bloqueado");
  });
});

describe("runBeforeSend relê assignee_kind fresco sob o lock, antes de enviar", () => {
  it("conversa assumida por humano no banco: a cadeia veta e o send() NUNCA é chamado", async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        const q = String(sql);
        if (q.includes("from conversations") && q.includes("assignee_kind")) {
          return { rows: [{ assignee_kind: "user" }] };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const persisted = vi.fn().mockResolvedValue({ rows: [{ id: "trace-1" }] });
    const pool = {
      connect: vi.fn().mockResolvedValue(client),
      query: persisted,
    } as unknown as pg.Pool;
    const log: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const send = vi.fn().mockResolvedValue({ kind: "sent", idempotencyKey: "k", messageId: "m" });

    const result = await runBeforeSend({
      pool,
      log,
      tenantId: "00000000-0000-4000-8000-000000000001",
      leadId: "00000000-0000-4000-8000-000000000002",
      channelSessionId: "00000000-0000-4000-8000-000000000004",
      body: "oi",
      optedOutThisTurn: false,
      crmDailyLimit: null,
      now: AGORA,
      rng: () => 0,
      send,
    });

    expect(result.status).toBe("vetoed");
    if (result.status !== "vetoed") throw new Error("inalcançável");
    expect(result.code).toBe("assumido_por_humano");
    expect(send).not.toHaveBeenCalled();
  });

  it("conversa com assignee_kind='ai' (ou sem dono): a IA segue despachando normalmente", async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        const q = String(sql);
        if (q.includes("from conversations") && q.includes("assignee_kind")) {
          return { rows: [{ assignee_kind: "ai" }] };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const persisted = vi.fn().mockResolvedValue({ rows: [{ id: "trace-1" }] });
    const pool = {
      connect: vi.fn().mockResolvedValue(client),
      query: persisted,
    } as unknown as pg.Pool;
    const log: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const send = vi.fn().mockResolvedValue({ kind: "sent", idempotencyKey: "k", messageId: "m" });

    const result = await runBeforeSend({
      pool,
      log,
      tenantId: "00000000-0000-4000-8000-000000000001",
      leadId: "00000000-0000-4000-8000-000000000002",
      channelSessionId: "00000000-0000-4000-8000-000000000004",
      body: "oi",
      optedOutThisTurn: false,
      crmDailyLimit: null,
      now: AGORA,
      rng: () => 0,
      send,
    });

    expect(result.status).toBe("sent");
    expect(send).toHaveBeenCalledTimes(1);
  });
});
