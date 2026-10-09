import { describe, expect, it, vi } from "vitest";
import type pg from "pg";
import type { EventRow } from "@/lib/event-log/dispatcher";
import {
  EVENTO_DADOS_CONFIRMADOS,
  fonteConfere,
  iniciarAposDadosConfirmados,
} from "./apos-dados-confirmados";

const uuid = (suffix: string) => `aaaaaaaa-0000-4000-8000-${suffix.padStart(12, "0")}`;
const payload = {
  case_id: uuid("1"),
  task_generation: 1,
  decision_event_id: uuid("2"),
  delivery_job_id: uuid("3"),
  post_delivery_pointer_id: uuid("4"),
};
const source = {
  id: payload.case_id,
  conversation_id: uuid("5"),
  contact_id: uuid("6"),
  lead_id: uuid("7"),
  task_kind: "payment_details",
  task_state: "completed",
  status: "resolved",
  wait_generation: 1,
  decision_event_id: payload.decision_event_id,
  delivery_job_id: payload.delivery_job_id,
  task_payload: {
    decision: "details_release",
    post_delivery_pointer_id: payload.post_delivery_pointer_id,
  },
  context_snapshot: null,
};
const event: EventRow = {
  id: uuid("8"),
  organization_id: uuid("9"),
  event_type: EVENTO_DADOS_CONFIRMADOS,
  entity_kind: "agent_case",
  entity_id: payload.case_id,
  payload,
  metadata: {},
  consumed_by: [],
  attempts: 0,
};

describe("prova da matrícula pósdados", () => {
  it("aceita somente a aprovação de dados concluída da mesma intenção", () =>
    expect(fonteConfere(source, payload)).toBe(true));
  it.each([
    { task_state: "awaiting_send" },
    { task_kind: "payment_review" },
    { status: "awaiting_human" },
    { wait_generation: 2 },
    { decision_event_id: uuid("99") },
    { delivery_job_id: uuid("99") },
    {
      task_payload: {
        decision: "payment_confirmed",
        post_delivery_pointer_id: payload.post_delivery_pointer_id,
      },
    },
    { task_payload: { decision: "details_release", post_delivery_pointer_id: uuid("99") } },
  ])("recusa fonte superada %j", (override) =>
    expect(fonteConfere({ ...source, ...override }, payload)).toBe(false),
  );
  it("não abre conexão para evento sem fluxo selecionado", async () => {
    const connect = vi.fn();
    const result = await iniciarAposDadosConfirmados({ connect } as unknown as pg.Pool, {
      ...event,
      payload: { ...payload, post_delivery_pointer_id: null },
    });
    expect(result.enrolled).toBe(false);
    expect(connect).not.toHaveBeenCalled();
  });
  it("saída sem efeito desfaz transação e libera conexão", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const release = vi.fn();
    const pool = { connect: async () => ({ query, release }) } as unknown as pg.Pool;
    expect((await iniciarAposDadosConfirmados(pool, event)).reason).toBe("caso_ausente");
    expect(query.mock.calls.at(-1)).toEqual(["rollback"]);
    expect(release).toHaveBeenCalledOnce();
  });
  it("mesmo se rollback falhar, libera conexão", async () => {
    const query = vi.fn(async (text: string) => {
      if (text === "rollback") throw new Error("rollback_failed");
      return { rows: [] };
    });
    const release = vi.fn();
    const pool = { connect: async () => ({ query, release }) } as unknown as pg.Pool;
    await expect(iniciarAposDadosConfirmados(pool, event)).rejects.toThrow("rollback_failed");
    expect(release).toHaveBeenCalledOnce();
  });
});
