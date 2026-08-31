import { describe, expect, it, vi } from "vitest";

import { nudgePendingOutcomes } from "@/app/api/v1/cron/appointment-outcome-nudge/route";

const AGORA = new Date("2026-08-30T12:00:00.000Z");

function makeAdminStub(pastAppointments: { id: string; organization_id: string; lead_id: string }[]) {
  const insertedInbox: unknown[] = [];
  const client = {
    from(table: string) {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        lt: () => Promise.resolve({ data: table === "appointments" ? pastAppointments : [], error: null }),
        insert: (row: unknown) => {
          insertedInbox.push(row);
          return Promise.resolve({ error: null });
        },
      };
      return chain;
    },
  };
  return { client, insertedInbox };
}

describe("appointment-outcome-nudge — a regra", () => {
  it("agendamento com >1h de atraso e ainda scheduled: abre aviso, NÃO muda status sozinho", async () => {
    const { client, insertedInbox } = makeAdminStub([
      { id: "a1", organization_id: "org-1", lead_id: "lead-1" },
    ]);

    const result = await nudgePendingOutcomes(client as never, AGORA);

    expect(result.nudged).toBe(1);
    expect(insertedInbox).toHaveLength(1);
    expect((insertedInbox[0] as { kind: string }).kind).toBe("appointment_outcome_pending");
  });

  it("sem agendamentos atrasados: nenhum aviso", async () => {
    const { client, insertedInbox } = makeAdminStub([]);
    const result = await nudgePendingOutcomes(client as never, AGORA);
    expect(result.nudged).toBe(0);
    expect(insertedInbox).toHaveLength(0);
  });
});
