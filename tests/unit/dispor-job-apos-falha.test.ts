import { beforeEach, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { JobRow } from "@/lib/agent-engine/queue/queue";
import { StaleServiceBoundaryError } from "@/lib/atendimento/fronteira";

const mocks = vi.hoisted(() => ({ cancel: vi.fn(), fail: vi.fn(), discard: vi.fn(), notify: vi.fn() }));
vi.mock("@/lib/agent-engine/queue/queue", () => ({ cancelJob: mocks.cancel, failJob: mocks.fail }));
vi.mock("@/lib/atendimento/descartar-followup-obsoleto", () => ({ descartarFollowupObsoleto: mocks.discard }));
vi.mock("@/lib/atendimento/aviso-caso-obsoleto", () => ({ avisarRespostaDeCasoObsoleto: mocks.notify }));
import { disporJobAposFalha } from "@/workers/agent-worker/dispor-job-apos-falha";

const pool = {} as Pool;
const log = { warn: vi.fn() };
const job = { id: "job", organization_id: "org", kind: "followup_turn", payload: {}, locked_by: "worker", claim_acquired_at: "2026-10-08T12:00:00.123456Z" } as JobRow;
beforeEach(() => vi.clearAllMocks());

it("o ramo do catch de follow-up obsoleto usa o descarte e seu log, não fail/retry", async () => {
  await disporJobAposFalha(pool, job, "worker", new StaleServiceBoundaryError(), true, log);
  expect(mocks.discard).toHaveBeenCalledWith(pool, job, "worker", log);
  expect(mocks.cancel).not.toHaveBeenCalled();
  expect(mocks.fail).not.toHaveBeenCalled();
});
it("caso obsoleto avisa antes de cancelar com o lease original", async () => {
  const caso = { ...job, kind: "case_reply_turn", payload: { case_id: "case" } } as JobRow;
  await disporJobAposFalha(pool, caso, "worker", new StaleServiceBoundaryError(), true, log);
  expect(mocks.notify).toHaveBeenCalledWith(pool, "org", "case");
  expect(mocks.cancel).toHaveBeenCalledWith(pool, "job", "worker", "service_boundary_stale", job.claim_acquired_at);
  expect(mocks.notify.mock.invocationCallOrder[0]).toBeLessThan(mocks.cancel.mock.invocationCallOrder[0]!);
  expect(mocks.discard).not.toHaveBeenCalled();
});
it("outro veto permanente preserva cancelamento, sem criar descarte de follow-up", async () => {
  await disporJobAposFalha(pool, job, "worker", new Error("veto\nmais detalhes"), true, log);
  expect(mocks.cancel).toHaveBeenCalledWith(pool, "job", "worker", "veto", job.claim_acquired_at);
  expect(mocks.discard).not.toHaveBeenCalled();
});
it("falha transitória mantém retry com precisão do lease", async () => {
  const error = new Error("banco indisponível");
  await disporJobAposFalha(pool, job, "worker", error, false, log);
  expect(mocks.fail).toHaveBeenCalledWith(pool, "job", "worker", error, job.claim_acquired_at);
  expect(mocks.discard).not.toHaveBeenCalled();
});
it("falha de armazenamento propaga ao catch de falha dupla", async () => {
  mocks.discard.mockRejectedValueOnce(new Error("descarte indisponível"));
  await expect(disporJobAposFalha(pool, job, "worker", new StaleServiceBoundaryError(), true, log)).rejects.toThrow("descarte indisponível");
});
