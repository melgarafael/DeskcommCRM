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
import { enviarTextoFixoPendente } from "@/lib/followup/enviar-texto-fixo";

vi.mock("@/lib/env", () => ({ env: { INTERNAL_SECRET: "dev-secret", INTERNAL_CRON_SECRET: "" } }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    from: vi.fn(),
    rpc: vi.fn(async () => ({ data: 0, error: null })),
  })),
}));
vi.mock("@/lib/followup/engine", () => ({
  runFollowupTick: vi.fn(),
  createSupabaseAdminClient: vi.fn(() => ({})),
}));
vi.mock("@/lib/followup/enviar-texto-fixo", () => ({
  enviarTextoFixoPendente: vi.fn(async () => 0),
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
    expect(vi.mocked(enviarTextoFixoPendente)).not.toHaveBeenCalled();
  });

  it("secret errado → 403", async () => {
    const { POST } = await import("@/app/api/v1/cron/followup-flow-worker/route");
    const res = await POST(req({ authorization: "Bearer wrong-secret" }));
    expect(res.status).toBe(403);
    expect(vi.mocked(runFollowupTick)).not.toHaveBeenCalled();
    expect(vi.mocked(enviarTextoFixoPendente)).not.toHaveBeenCalled();
  });

  it("secret correto → 200, chama runFollowupTick e audita followup.worker_run", async () => {
    const summary = { claimed: 3, advanced: 1, scheduled: 2, failed: 0, dead: 0 };
    vi.mocked(runFollowupTick).mockResolvedValue(summary);

    const { POST } = await import("@/app/api/v1/cron/followup-flow-worker/route");
    const res = await POST(req({ authorization: "Bearer dev-secret" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: typeof summary & { confirmation_sweep: unknown } };
    expect(body.data).toEqual({ ...summary, confirmation_sweep: { ok: true, avisos: 0 } });
    expect(vi.mocked(createSupabaseAdminClient)).toHaveBeenCalledWith(expect.anything());
    expect(vi.mocked(createAdminClient)).toHaveBeenCalled();
    expect(vi.mocked(enviarTextoFixoPendente)).toHaveBeenCalled();
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "followup.worker_run", metadata: summary }),
    );
  });

  it("tick vazio ainda drena texto fixo pendente — senão o no_reply enfileira e a mensagem nunca sai", async () => {
    vi.mocked(runFollowupTick).mockResolvedValue({
      claimed: 0,
      advanced: 0,
      scheduled: 0,
      failed: 0,
      dead: 0,
    });
    const { POST } = await import("@/app/api/v1/cron/followup-flow-worker/route");
    const res = await POST(req({ authorization: "Bearer dev-secret" }));
    expect(res.status).toBe(200);
    expect(vi.mocked(enviarTextoFixoPendente)).toHaveBeenCalled();
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });

  it("runFollowupTick lança → 500 internal_error, sem audit", async () => {
    vi.mocked(runFollowupTick).mockRejectedValue(new Error("db down"));

    const { POST } = await import("@/app/api/v1/cron/followup-flow-worker/route");
    const res = await POST(req({ authorization: "Bearer dev-secret" }));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("internal_error");
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
    expect(vi.mocked(enviarTextoFixoPendente)).not.toHaveBeenCalled();
  });
  // Antes, erro na varredura de confirmação de presença devolvia 500 ANTES do
  // motor: um defeito só na agenda parava o follow-up de todas as orgs. Os dois
  // casos abaixo provam que a falha fica isolada — o motor roda, o dreno roda —
  // e que ela NÃO some: volta na resposta, no log e na trilha.
  it.each([
    [
      "erro devolvido pelo banco",
      () => ({
        from: vi.fn(),
        rpc: vi.fn(async () => ({ data: null, error: { message: "database down" } })),
      }),
      "database down",
    ],
    [
      "exceção do client (rede)",
      () => ({
        from: vi.fn(),
        rpc: vi.fn(async () => {
          throw new Error("fetch failed");
        }),
      }),
      "fetch failed",
    ],
  ])(
    "varredura de confirmação falha (%s) → motor de follow-up ainda roda",
    async (_caso, admin, erro) => {
      vi.mocked(createAdminClient).mockReturnValueOnce(admin() as never);
      const summary = { claimed: 1, advanced: 1, scheduled: 0, failed: 0, dead: 0 };
      vi.mocked(runFollowupTick).mockResolvedValue(summary);
      const { logger } = await import("@/lib/logger");
      const logErro = vi.spyOn(logger, "error").mockImplementation(() => undefined);

      const { POST } = await import("@/app/api/v1/cron/followup-flow-worker/route");
      const res = await POST(req({ authorization: "Bearer dev-secret" }));

      expect(res.status).toBe(200);
      expect(vi.mocked(runFollowupTick)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(enviarTextoFixoPendente)).toHaveBeenCalled();
      const body = (await res.json()) as { data: Record<string, unknown> };
      expect(body.data).toEqual({ ...summary, confirmation_sweep: { ok: false, erro } });
      expect(logErro).toHaveBeenCalledWith(
        expect.stringContaining("fn_appointment_confirmation_sweep"),
        expect.objectContaining({ error: erro }),
      );
      expect(vi.mocked(audit)).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "agenda.confirmation_sweep_run",
          metadata: { falhou: true, erro },
        }),
      );
      // O motor rodou e mexeu: a trilha dele continua sendo escrita.
      expect(vi.mocked(audit)).toHaveBeenCalledWith(
        expect.objectContaining({ action: "followup.worker_run", metadata: summary }),
      );
      logErro.mockRestore();
    },
  );

  it("varredura com avisos audita agenda.confirmation_sweep_run e devolve a contagem", async () => {
    vi.mocked(createAdminClient).mockReturnValueOnce({
      from: vi.fn(),
      rpc: vi.fn(async () => ({ data: 2, error: null })),
    } as never);
    vi.mocked(runFollowupTick).mockResolvedValue({
      claimed: 0,
      advanced: 0,
      scheduled: 0,
      failed: 0,
      dead: 0,
    });

    const { POST } = await import("@/app/api/v1/cron/followup-flow-worker/route");
    const res = await POST(req({ authorization: "Bearer dev-secret" }));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { confirmation_sweep: unknown } };
    expect(body.data.confirmation_sweep).toEqual({ ok: true, avisos: 2 });
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "agenda.confirmation_sweep_run", metadata: { avisos: 2 } }),
    );
  });
});
