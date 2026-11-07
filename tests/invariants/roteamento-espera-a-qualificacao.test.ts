/**
 * #3966 — COM RODÍZIO/CARGA LIGADOS, A CONVERSA ESPERA A IA QUALIFICAR.
 *
 * ─── O defeito, medido ──────────────────────────────────────────────────────
 *
 * A conversa nova pede roteamento no INSERT (`trg_conversation_routing_requested`)
 * e o worker a entregava em menos de 1 min. A atribuição grava
 * `assignee_kind='user'` e o gate cala a IA (`conversa_de_humano`): a fila
 * desligava o agente que deveria qualificar, e o lead ficava sem atendimento.
 *
 * O lado TS (pulado pelo worker — `lib/routing/qualificacao-da-ia.ts`) consome o
 * pedido. A outra metade é DESTE banco: quando a qualificação termina
 * (`last_handoff_at`, gravado pelos dois caminhos de passagem), a conversa
 * precisa voltar à fila — uma vez, não a cada mensagem.
 *
 * ─── O que este arquivo prova, em Postgres real ─────────────────────────────
 *
 *   1. o handoff pede o roteamento UMA vez (repetir o handoff não duplica);
 *   2. conversa COM dono não pede nada — quem manda é o dono;
 *   3. ⭐ sem IA ligada, o worker distribui no NASCIMENTO (compatibilidade);
 *   4. com agente publicado no número e sem handoff, o worker NÃO distribui e o
 *      pedido morre consumido;
 *   5. ao terminar a qualificação, o pedido reemitido distribui a conversa —
 *      uma única vez.
 */
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createAdminClient } from "@/lib/supabase/admin";
import { runRoutingWorker } from "@/lib/routing/worker";

import {
  GOV_AGENT_A as ana,
  GOV_CONV_UNASSIGNED as conv,
  GOV_MANAGER as manager,
  GOV_ORG as org,
  GOV_SESSION as channel,
  seedGov,
} from "./gov-helpers";
import { routingPgSupabase } from "../support/routing-pg-supabase";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const pool = new Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
  max: 5,
});
const query = (text: string, args: unknown[] = []) => pool.query(text, args);

const pedidos = async () =>
  (
    await query(
      "select status from event_log where organization_id=$1 and entity_id=$2 and event_type='conversation.routing_requested' order by created_at",
      [org, conv],
    )
  ).rows as Array<{ status: string }>;

/** O evento, por conversa: o `fn_wake_channel_routing` pode tocar outras. */
const limparPedidos = () =>
  query(
    "delete from event_log where organization_id=$1 and event_type='conversation.routing_requested'",
    [org],
  );

/** Com sessão: a MESMA porta que a tela usa (`fn_set_channel_routing`). */
async function asUser(user: string, text: string, args: unknown[] = [], aal = "aal1") {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, aal })]);
    const result = await c.query(text, args);
    await c.query("commit");
    return result;
  } catch (error) {
    await c.query("rollback");
    throw error;
  } finally {
    c.release();
  }
}

const policyDoNumero = (users: string[]) =>
  asUser(manager, "select fn_set_channel_routing($1,$2,$3,false,$4,$5) result", [
    org,
    channel,
    users,
    "round_robin",
    null,
  ]);

/** Simula o UPDATE único de `performHumanHandoff`: status + marcador juntos. */
const passarParaHumano = () =>
  query(
    `update conversations
        set status = case when status = 'ai_handling' then 'pending' else status end,
            bot_silenced_until = 'infinity',
            last_handoff_at = now()
      where organization_id = $1 and id = $2`,
    [org, conv],
  );

const donoDaConversa = async () =>
  (await query("select assigned_to_user_id from conversations where organization_id=$1 and id=$2", [org, conv]))
    .rows[0].assigned_to_user_id as string | null;

const rodarWorker = async () => {
  const adapter = routingPgSupabase(pool);
  vi.mocked(createAdminClient).mockReturnValue(adapter.client as never);
  const result = await runRoutingWorker({ now: new Date() });
  expect(adapter.errors).toEqual([]);
  return result;
};

/** O agente de qualificação publicado NESTE número (a régua do motor). */
const publicarAgente = async () => {
  const agente = await query(
    `insert into ai_agents (organization_id, name, system_prompt, kind)
     values ($1, 'Qualificação', 'Qualifique o lead.', 'rag_bot')
     returning id`,
    [org],
  );
  const versao = await query(
    `insert into ai_agent_versions
       (organization_id, agent_id, version_number, system_prompt, provider, model, channel_session_id, status, published_at)
     values ($1, $2, 1, 'Qualifique o lead.', 'anthropic', 'claude-sonnet-4-6', $3, 'published', now())
     returning id`,
    [org, agente.rows[0].id, channel],
  );
  const versaoId = versao.rows[0].id as string;
  await query("update ai_agents set published_version_id = $1 where id = $2", [versaoId, agente.rows[0].id]);
  return versaoId;
};

beforeAll(() => seedGov());
afterAll(() => pool.end());

beforeEach(async () => {
  await query("delete from ai_agents where organization_id=$1", [org]);
  await query("delete from ai_agent_versions where organization_id=$1", [org]);
  await query("delete from channel_routing_policies where organization_id=$1", [org]);
  await policyDoNumero([ana]);
  await query(
    `insert into attendant_availability (organization_id, user_id, is_available, capacity, schedule)
     values ($1, $2, true, 1, '{}')
     on conflict (organization_id, user_id) do update set is_available = true, capacity = 1, schedule = '{}'`,
    [org, ana],
  );
  await query(
    `update user_organizations set revoked_at = null, role = 'agent' where organization_id = $1 and user_id = $2`,
    [org, ana],
  );
  await query(
    `update organizations
        set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{routing}', '{"mode":"round_robin","max_retries":3,"backoff_seconds":1}')
      where id = $1`,
    [org],
  );
  await query(
    `update conversations
        set assigned_to_user_id = null, assigned_to_user_name = null, assigned_at = null,
            assignee_kind = null, status = 'open', last_handoff_at = null, bot_silenced_until = null
      where organization_id = $1 and id = $2`,
    [org, conv],
  );
  await limparPedidos();
});

describe("#3966 — a passagem para humano devolve a conversa à fila", () => {
  it("o handoff pede o roteamento UMA vez; repetir o handoff não duplica", async () => {
    await passarParaHumano();
    const primeiro = await pedidos();
    expect(primeiro).toHaveLength(1);
    expect(primeiro[0].status).toBe("pending");

    await passarParaHumano();
    // A deduplicação é do `fn_request_channel_routing` (índice parcial por
    // entity_id com o pedido pendente): um handoff repetido atualiza
    // `next_attempt_at`, não abre outro pedido.
    expect(await pedidos()).toHaveLength(1);
  });

  it("conversa COM dono não pede roteamento — quem manda é o dono", async () => {
    await query(
      "update conversations set assigned_to_user_id=$1, assignee_kind='user', status='claimed' where organization_id=$2 and id=$3",
      [ana, org, conv],
    );
    await passarParaHumano();
    expect(await pedidos()).toHaveLength(0);
  });

  it("⭐ sem IA ligada, o worker distribui no NASCIMENTO (compatibilidade)", async () => {
    await query("select fn_request_channel_routing($1,$2)", [org, conv]);
    expect((await pedidos()).length).toBe(1);

    const result = await rodarWorker();
    expect(result.outcomes.skipped_ia_qualificando, JSON.stringify(result)).toBe(0);
    expect(result.outcomes.assigned, JSON.stringify(result)).toBe(1);
    expect(await donoDaConversa()).toBe(ana);
  });

  it("com agente publicado no número e sem handoff, NADA é distribuído", async () => {
    await publicarAgente();
    await query("select fn_request_channel_routing($1,$2)", [org, conv]);

    const result = await rodarWorker();
    expect(result.outcomes.skipped_ia_qualificando).toBe(1);
    expect(result.outcomes.assigned).toBe(0);
    expect(await donoDaConversa()).toBeNull();
    // O pedido do nascimento morreu consumido — é o que impede o retrabalho a
    // cada tique do worker.
    expect((await pedidos()).map((p) => p.status)).toEqual(["done"]);
  });

  it("ao terminar a qualificação, o pedido reemitido distribui UMA vez", async () => {
    await publicarAgente();
    await query("select fn_request_channel_routing($1,$2)", [org, conv]);
    expect((await rodarWorker()).outcomes.skipped_ia_qualificando).toBe(1);
    expect(await donoDaConversa()).toBeNull();

    // A IA passa para humano: status + last_handoff_at no MESMO update.
    await passarParaHumano();
    const reemissao = await pedidos();
    expect(reemissao.filter((p) => p.status === "pending")).toHaveLength(1);
    expect(reemissao).toHaveLength(2); // o do nascimento (done) + o da passagem

    const result = await rodarWorker();
    expect(result.outcomes.assigned, JSON.stringify(result)).toBe(1);
    expect(await donoDaConversa(), JSON.stringify(result)).toBe(ana);
    // Distribuiu UMA vez: nenhum pedido novo depois da entrega.
    expect((await pedidos()).filter((p) => p.status === "pending")).toHaveLength(0);
  });
});
