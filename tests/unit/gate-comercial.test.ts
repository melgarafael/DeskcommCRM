import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { runBeforeSend } from "@/lib/agent-engine/guardrails/before-send";
import type { Logger } from "@/lib/agent-engine/obs/logger";
const RESPOSTA = "Os óculos custam R$ 299,90.";
const COMERCIAL = new Date("2026-07-28T13:00:00Z"); // 10h BRT, terça — dentro da janela

function chamaCadeiaReal(args: { body: string; armado: boolean }): {
  run: ReturnType<typeof runBeforeSend>;
  inserts: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
} {
  const client = { query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() };
  const inserts = vi.fn().mockResolvedValue({ rows: [{ id: "trace-1" }] });
  const pool = { connect: vi.fn().mockResolvedValue(client), query: inserts } as unknown as pg.Pool;
  const log: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const send = vi.fn(async () => ({ kind: "sent" as const, idempotencyKey: "k", messageId: "m" }));
  return {
    inserts,
    send,
    run: runBeforeSend({
      pool,
      log,
      tenantId: "00000000-0000-4000-8000-000000000001",
      leadId: "00000000-0000-4000-8000-000000000002",
      jobId: "00000000-0000-4000-8000-000000000003",
      channelSessionId: "00000000-0000-4000-8000-000000000004",
      body: args.body,
      optedOutThisTurn: false,
      crmDailyLimit: null,
      now: COMERCIAL,
      rng: () => 0,
      sleep: async () => {},
      ...(args.armado ? { enforceCommercialRestriction: true } : {}),
      send,
    }),
  };
}

describe("a cadeia REAL barra a resposta comercial — e só quando armada", () => {
  it("armada: veta no gate certo e o trace leva só as categorias", async () => {
    const { run, inserts, send } = chamaCadeiaReal({ body: RESPOSTA, armado: true });
    const r = await run;
    expect(r.status).toBe("vetoed");
    expect(send).not.toHaveBeenCalled();
    if (r.status !== "vetoed") throw new Error("inalcançável");
    expect(r.gate).toBe("commercial_restriction");
    expect(r.code).toBe("commercial_requires_human");
    expect(r.trace).toContainEqual({
      gate: "commercial_restriction",
      verdict: "veto",
      code: "commercial_requires_human",
      detail: { restricted_kind: "commercial" },
    });
    const sql = String(inserts.mock.calls[0]?.[0] ?? "");
    expect(sql).toMatch(/insert into before_send_traces/);
  });

  it("DESARMADA: o MESMO corpo é enviado", async () => {
    const r = await chamaCadeiaReal({ body: RESPOSTA, armado: false }).run;
    expect(r.status).toBe("sent");
    expect(r.trace).toContainEqual({ gate: "commercial_restriction", verdict: "pass" });
  });
});
