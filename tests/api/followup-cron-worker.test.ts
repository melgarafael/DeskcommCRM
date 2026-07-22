/**
 * Task 4.2 — GET/POST /api/v1/cron/followup-flow-worker.
 *
 * Prova o contrato de auth fail-closed (mesmo padrão do routing-worker: Bearer
 * INTERNAL_CRON_SECRET|INTERNAL_SECRET) e o encadeamento pro engine
 * (`runFollowupTick`) + audit agregada por tick — sem tocar Postgres real (o
 * DB real é coberto por `tests/invariants/followup-engine.test.ts`, Task 4.1).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { runFollowupTick, createSupabaseAdminClient } from "@/lib/followup/engine";

vi.mock("@/lib/env", () => ({ env: { INTERNAL_SECRET: "dev-secret", INTERNAL_CRON_SECRET: "" } }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({ from: vi.fn() })) }));
vi.mock("@/lib/followup/engine", () => ({
  runFollowupTick: vi.fn(),
  createSupabaseAdminClient: vi.fn(() => ({})),
}));

function req(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/v1/cron/followup-flow-worker", { headers });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET/POST /api/v1/cron/followup-flow-worker", () => {
  it("sem Authorization header → 403 forbidden, runFollowupTick NÃO é chamado", async () => {
    const { GET } = await import("@/app/api/v1/cron/followup-flow-worker/route");
    const res = await GET(req());
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("forbidden");
    expect(vi.mocked(runFollowupTick)).not.toHaveBeenCalled();
  });

  it("secret errado → 403", async () => {
    const { POST } = await import("@/app/api/v1/cron/followup-flow-worker/route");
    const res = await POST(req({ authorization: "Bearer wrong-secret" }));
    expect(res.status).toBe(403);
    expect(vi.mocked(runFollowupTick)).not.toHaveBeenCalled();
  });

  it("secret correto → 200, chama runFollowupTick e audita followup.worker_run", async () => {
    const summary = { claimed: 3, advanced: 1, scheduled: 2, failed: 0, dead: 0 };
    vi.mocked(runFollowupTick).mockResolvedValue(summary);

    const { POST } = await import("@/app/api/v1/cron/followup-flow-worker/route");
    const res = await POST(req({ authorization: "Bearer dev-secret" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: typeof summary };
    expect(body.data).toEqual(summary);
    expect(vi.mocked(createSupabaseAdminClient)).toHaveBeenCalledWith(expect.anything());
    expect(vi.mocked(createAdminClient)).toHaveBeenCalled();
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "followup.worker_run", metadata: summary }),
    );
  });

  it("runFollowupTick lança → 500 internal_error, sem audit", async () => {
    vi.mocked(runFollowupTick).mockRejectedValue(new Error("db down"));

    const { POST } = await import("@/app/api/v1/cron/followup-flow-worker/route");
    const res = await POST(req({ authorization: "Bearer dev-secret" }));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("internal_error");
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });
});
