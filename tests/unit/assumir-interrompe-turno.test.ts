import { describe, expect, it, vi } from "vitest";
import {
  guardServiceEffect,
  guardServiceTools,
  requireCurrentAutonomousTurn,
  withServiceJob,
} from "@/lib/atendimento/fronteira-server";
import type { JobRow, Queryable } from "@/lib/agent-engine/queue/queue";

const boundary = {
  organization_id: "org",
  contact_id: "contact",
  conversation_id: "conversation",
  service_revision: 1,
  demanda_id: null,
  demanda_revision: null,
  status: "open",
  demanda_fechada_em: null,
};
const job = {
  id: "job",
  organization_id: "org",
  contact_id: "contact",
  kind: "inbound_turn",
  locked_by: "worker",
  claim_acquired_at: "2026-10-07T17:00:00.123456Z",
  payload: { service_boundary: boundary },
} as unknown as JobRow;
function mundo() {
  let vigente = true;
  const db = {
    query: vi.fn(async (sql: string) => ({
      rows: [sql.includes("from job_queue") ? { current: vigente } : boundary],
    })),
  } as unknown as Queryable;
  return {
    db,
    assumir: () => {
      vigente = false;
    },
    devolver: () => {
      /* liberar a conversa não reabre o job */
    },
  };
}
describe("o turno perde comando quando humano assume", () => {
  it.each(["crm_book_appointment", "crm_update_lead", "send_message"])(
    "assumir antes de %s impede o efeito",
    async (name) => {
      const m = mundo();
      const efeito = vi.fn(async () => ({ ok: true }));
      await withServiceJob(m.db, job, async () => {
        const tools = guardServiceTools({ [name]: { inputSchema: {} as never, execute: efeito } });
        m.assumir();
        await expect(tools![name]!.execute!({}, {} as never)).rejects.toThrow(
          "service_boundary_stale",
        );
      });
      expect(efeito).not.toHaveBeenCalled();
    },
  );
  it("assumir e devolver não ressuscita o turno antigo nem um retry", async () => {
    const m = mundo();
    await withServiceJob(m.db, job, async () => {
      m.assumir();
      m.devolver();
      await expect(guardServiceEffect()).rejects.toThrow("service_boundary_stale");
    });
    await expect(withServiceJob(m.db, job, async () => {})).rejects.toThrow(
      "service_boundary_stale",
    );
  });
  it("tomada durante espera da ferramenta veta na guarda final, sem desfazer o anterior", async () => {
    const m = mundo();
    let escritos = 0;
    await withServiceJob(m.db, job, async () => {
      const tools = guardServiceTools({
        reservar: {
          inputSchema: {} as never,
          execute: async () => {
            escritos++; // efeito já concluído antes da tomada continua existindo
            await Promise.resolve().then(m.assumir);
            await guardServiceEffect(); // o handler relê depois da consulta demorada
            escritos++;
          },
        },
      });
      await expect(tools!.reservar!.execute!({}, {} as never)).rejects.toThrow(
        "service_boundary_stale",
      );
    });
    expect(escritos).toBe(1);
  });
  it("handoff do próprio turno mantém lease e seus registros podem concluir", async () => {
    const m = mundo();
    await withServiceJob(m.db, job, async () => {
      await guardServiceEffect();
      await guardServiceEffect();
    });
  });
  it.each(["transactional_delivery", "approved_reply", "operator_turn"] as const)(
    "não vence autoridade independente: %s",
    async (kind) => {
      const m = mundo();
      m.assumir();
      await expect(requireCurrentAutonomousTurn(m.db, { ...job, kind })).resolves.toBeUndefined();
      expect(m.db.query).not.toHaveBeenCalled();
    },
  );
  it("não admite lease ausente nem recompõe aquisição com o estado atual", async () => {
    const m = mundo();
    await expect(
      requireCurrentAutonomousTurn(m.db, { ...job, claim_acquired_at: undefined }),
    ).rejects.toThrow("service_boundary_stale");
    await requireCurrentAutonomousTurn(m.db, job);
    expect(m.db.query).toHaveBeenLastCalledWith(expect.any(String), [
      "org",
      "job",
      "contact",
      "inbound_turn",
      "worker",
      "2026-10-07T17:00:00.123456Z",
    ]);
  });
});
