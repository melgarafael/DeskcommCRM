import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { seedGov, GOV_ORG as org, GOV_AGENT_A as ana, GOV_CONV_UNASSIGNED as conv } from "./gov-helpers";

// #1562 / #1619: revogar um membro devolve as conversas dele à fila, mas o
// silêncio do bot segue a regra do release de fn_conversation_assign — a
// conversa que a IA passou a um humano (last_handoff_at) não volta para a IA.
// Arquivo próprio porque tests/invariants/** existente é congelado.
const pool = new Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`, max: 2 });
const query = (text: string, args: unknown[] = []) => pool.query(text, args);

beforeAll(() => seedGov());
afterAll(() => pool.end());

describe("revogação de membro e o handoff da IA", () => {
  it("conversa passada pela IA a um humano volta para a fila humana, com a IA ainda calada", async () => {
    await query(
      "update conversations set assigned_to_user_id=$1, assigned_to_user_name='Ana', assignee_kind='user', status='claimed', bot_silenced_until='infinity', last_handoff_at=now() where organization_id=$2 and id=$3",
      [ana, org, conv],
    );
    await query("update user_organizations set revoked_at=now() where organization_id=$1 and user_id=$2", [org, ana]);

    const r = await query(
      "select assigned_to_user_id, status, bot_silenced_until = 'infinity'::timestamptz as calada from conversations where organization_id=$1 and id=$2",
      [org, conv],
    );
    expect(r.rows[0]).toMatchObject({ assigned_to_user_id: null, status: "open", calada: true });

    const ev = await query(
      "select from_user_id, to_user_id, reason from conversation_assignment_events where organization_id=$1 and conversation_id=$2 order by created_at desc limit 1",
      [org, conv],
    );
    expect(ev.rows[0]).toMatchObject({ from_user_id: ana, to_user_id: null, reason: "member_revoked" });
  });
});
