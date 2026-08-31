import { describe, expect, it } from "vitest";

import { nudgePendingOutcomes } from "@/app/api/v1/cron/appointment-outcome-nudge/route";

const AGORA = new Date("2026-08-30T12:00:00.000Z");

/**
 * Dublê do admin client. `.limit()` e `.in()` são os pontos TERMINAIS da
 * chain (resolvem a Promise) — `.select()`/`.eq()`/`.lt()` só encadeiam. Isso
 * espelha o formato real do query builder: `appointments` termina em
 * `.limit(BATCH_LIMIT)` (Finding 2 do review — corte real no banco, não
 * pós-fetch) e a checagem de dedup em `agent_inbox_items` termina em
 * `.in("ref_id", ids)` (Finding 3 — não reavisa quem já tem item `open`).
 */
function makeAdminStub(
  pastAppointments: { id: string; organization_id: string; lead_id: string }[],
  existingOpenRefIds: string[] = [],
) {
  const insertedInbox: unknown[] = [];
  const client = {
    from(table: string) {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        lt: () => chain,
        limit: () => Promise.resolve({ data: table === "appointments" ? pastAppointments : [], error: null }),
        in: () =>
          Promise.resolve({
            data: table === "agent_inbox_items" ? existingOpenRefIds.map((id) => ({ ref_id: id })) : [],
            error: null,
          }),
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

  it("agendamento que já tem aviso ABERTO: não é reavisado de novo", async () => {
    const { client, insertedInbox } = makeAdminStub(
      [{ id: "a1", organization_id: "org-1", lead_id: "lead-1" }],
      ["a1"],
    );

    const result = await nudgePendingOutcomes(client as never, AGORA);

    expect(result.nudged).toBe(0);
    expect(insertedInbox).toHaveLength(0);
  });
});
