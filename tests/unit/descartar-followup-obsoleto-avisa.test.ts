/**
 * #4696 — o descarte do retorno combinado passa pelo aviso, sem banco.
 *
 * A prova de ponta a ponta mora em `tests/invariants/aviso-do-retorno-descartado.test.ts`
 * (Postgres real). Esta mede a FIAÇÃO que um merge pode desligar calado: o
 * descarte que encerra o job chama `registrarRetornoDescartado` com a conversa
 * da fronteira e o instante combinado, no MESMO cliente de transação, e não
 * chama quando o descarte não foi deste ciclo. E mede `quandoCombinado` com os
 * dois transportes de data (o `Date` do driver e o texto do payload).
 */
import { beforeEach, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { JobRow } from "@/lib/agent-engine/queue/queue";

const mocks = vi.hoisted(() => ({ cancel: vi.fn(), registrar: vi.fn() }));
vi.mock("@/lib/agent-engine/queue/queue", () => ({ cancelJob: mocks.cancel }));
vi.mock("@/lib/atendimento/aviso-retorno-descartado", async (original) => ({
  ...(await original<typeof import("@/lib/atendimento/aviso-retorno-descartado")>()),
  registrarRetornoDescartado: mocks.registrar,
}));

import { descartarFollowupObsoleto } from "@/lib/atendimento/descartar-followup-obsoleto";
import { quandoCombinado } from "@/lib/atendimento/aviso-retorno-descartado";

const tx = { query: vi.fn(), release: vi.fn() };
const pool = { connect: vi.fn(async () => tx) } as unknown as Pool;
const log = { warn: vi.fn() };
const RUN_AFTER = new Date("2026-11-14T18:00:00Z");
const job = {
  id: "job",
  organization_id: "org",
  contact_id: "contato",
  kind: "followup_turn",
  run_after: RUN_AFTER,
  payload: { service_boundary: { conversation_id: "conversa" } },
  locked_by: "worker",
  claim_acquired_at: "2026-11-14T17:00:00.123456Z",
} as unknown as JobRow;

beforeEach(() => {
  vi.clearAllMocks();
  tx.query.mockImplementation(async (sql: string) =>
    sql.includes("for update") ? { rows: [{ id: "job" }] } : { rows: [] },
  );
  mocks.registrar.mockResolvedValue({ aviso: null, linhaDoTempo: false, falhou: false });
});

it("descarte deste ciclo registra o aviso na mesma transação, com conversa e instante combinado", async () => {
  mocks.cancel.mockResolvedValue({ id: "job" });
  await descartarFollowupObsoleto(pool, job, "worker", log);
  expect(mocks.registrar).toHaveBeenCalledExactlyOnceWith(
    tx,
    { organizationId: "org", contactId: "contato", conversationId: "conversa", jobId: "job", combinadoPara: RUN_AFTER },
    log,
  );
  const ordem = tx.query.mock.calls.map(([sql]) => String(sql));
  expect(ordem.at(-1)).toBe("commit");
});

it("dedup + contato sem negócio aberto não é alarme (falhou: false)", async () => {
  mocks.cancel.mockResolvedValue({ id: "job" });
  await descartarFollowupObsoleto(pool, job, "worker", log);
  expect(log.warn).not.toHaveBeenCalled();
});

it("escrita que estoura deixa a última testemunha no log", async () => {
  mocks.cancel.mockResolvedValue({ id: "job" });
  mocks.registrar.mockResolvedValue({ aviso: null, linhaDoTempo: false, falhou: true });
  await descartarFollowupObsoleto(pool, job, "worker", log);
  expect(log.warn).toHaveBeenCalledExactlyOnceWith("followup_descartado_sem_rastro", {
    job_id: "job",
    organization_id: "org",
    contact_id: "contato",
  });
});

it("lease mudado entre o for update e o cancel: o descarte não é deste ciclo, o aviso também não", async () => {
  mocks.cancel.mockResolvedValue(null);
  await descartarFollowupObsoleto(pool, job, "worker", log);
  expect(mocks.registrar).not.toHaveBeenCalled();
});

it("job sem conversa na fronteira não inventa aviso sem destino", async () => {
  mocks.cancel.mockResolvedValue({ id: "job" });
  await descartarFollowupObsoleto(pool, { ...job, payload: {} } as JobRow, "worker", log);
  expect(mocks.registrar).not.toHaveBeenCalled();
});

it("quandoCombinado lê o Date do driver e o texto do payload igual, no fuso da empresa", () => {
  expect(quandoCombinado(RUN_AFTER, "America/Sao_Paulo")).toBe("14/11 às 15:00");
  expect(quandoCombinado(RUN_AFTER.toISOString(), "America/Sao_Paulo")).toBe("14/11 às 15:00");
  expect(quandoCombinado(null, "America/Sao_Paulo")).toBeNull();
  expect(quandoCombinado("não é data", "America/Sao_Paulo")).toBeNull();
});
