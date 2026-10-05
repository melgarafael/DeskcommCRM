/**
 * Modo `load` do roteamento (#1539, PR #1711) com o worker REAL contra o banco.
 *
 * O teste unitário de decide.ts prova a escolha; este prova que o worker chega
 * nela: que `worker.ts` carrega os elegíveis também no modo load e que a carga
 * contada no banco decide. O cenário discrimina load de round_robin — o rodízio
 * daria a conversa à ana, o load dá ao bruno —, então os dois consertos ficam
 * vermelhos se voltarem atrás.
 */
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { createAdminClient } from "@/lib/supabase/admin";
import { runRoutingWorker } from "@/lib/routing/worker";
import { routingPgSupabase } from "../support/routing-pg-supabase";
import {
  seedGov,
  GOV_ORG as org,
  GOV_AGENT_A as ana,
  GOV_AGENT_B as bruno,
  GOV_CONV_UNASSIGNED as conv,
  GOV_CONV_CLAIM as second,
  GOV_CONV_AGENT_B as third,
} from "./gov-helpers";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));

const pool = new Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`, max: 5 });
const query = (text: string, args: unknown[] = []) => pool.query(text, args);

beforeAll(() => seedGov());
afterAll(() => pool.end());

it("modo load: a conversa vai para quem tem menos conversas, onde o rodízio escolheria o outro", async () => {
  await query("update organizations set settings=jsonb_set(coalesce(settings,'{}'),'{routing}','{\"mode\":\"load\"}') where id=$1", [org]);
  await query("update conversations set assigned_to_user_id=null,assignee_kind=null,status='open' where organization_id=$1", [org]);
  // Capacidade 5 para os dois: com folga pequena a ana sairia pelo filtro de
  // capacidade, e o caso passaria em qualquer modo.
  for (const user of [ana, bruno]) {
    await query(
      "insert into attendant_availability(organization_id,user_id,is_available,capacity,schedule) values($1,$2,true,5,'{}') on conflict(organization_id,user_id) do update set is_available=true,capacity=5,schedule='{}'",
      [org, user],
    );
  }
  // Ana com carga 2, bruno com 0 — e o bruno com a atribuição mais recente do
  // canal, para o rodízio (quem está há mais tempo sem receber) apontar a ana.
  await query(
    "update conversations set assigned_to_user_id=$1,assigned_to_user_name='Ana',assignee_kind='user',status='claimed' where organization_id=$2 and id=any($3)",
    [ana, org, [second, third]],
  );
  await query(
    "insert into conversation_assignment_events(organization_id,conversation_id,to_user_id,reason,created_at) values($1,$2,$3,'routing',now()+interval '1 hour')",
    [org, third, bruno],
  );
  await query("delete from event_log where organization_id=$1 and event_type='conversation.routing_requested'", [org]);
  await query("select fn_request_channel_routing($1,$2)", [org, conv]);

  const adapter = routingPgSupabase(pool);
  vi.mocked(createAdminClient).mockReturnValue(adapter.client as never);
  const result = await runRoutingWorker({ now: new Date() });

  expect(adapter.errors).toEqual([]);
  expect(result.outcomes.assigned).toBe(1);
  const dono = await query("select assigned_to_user_id from conversations where organization_id=$1 and id=$2", [org, conv]);
  expect(dono.rows[0].assigned_to_user_id).toBe(bruno);
});
