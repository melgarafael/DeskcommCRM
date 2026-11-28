/**
 * #5381 — O RESET DO GESTOR NÃO APAGA O QUE SÓ ADMIN CONFIGURA.
 *
 * Na tela "Distribuição por número", o gestor pode "voltar a usar a
 * organização". O reset apagava a linha de `channel_routing_policies` inteira —
 * e levava junto `ai_wait_minutes` (#3966) e `sector_id` (#5374/#5380), que são
 * de admin. O gestor desfazia, pelo reset, o que não consegue configurar.
 *
 * O que este arquivo prova, em Postgres real, pela MESMA porta da tela
 * (`fn_set_channel_routing`, com sessão):
 *   1. o gestor reseta um número com fila de entrada e espera da IA: as duas
 *      continuam com o valor que o admin deixou, a regra de gestor sai
 *      (responsáveis, modo e destino padrão) e o número volta a ser elegível
 *      pela organização (`fn_channel_routing_claim` não recusa mais);
 *   2. o admin reseta o mesmo número: a regra some inteira.
 */
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  GOV_ADMIN as admin,
  GOV_AGENT_A as atendente,
  GOV_CONV_UNASSIGNED as conversa,
  GOV_MANAGER as manager,
  GOV_ORG as org,
  GOV_SESSION as canal,
  seedGov,
} from "./gov-helpers";

const pool = new Pool({
  connectionString: `postgresql://postgres:***@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
  max: 5,
});
const query = (text: string, args: unknown[] = []) => pool.query(text, args);

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

const resetar = (quem: string) =>
  asUser(quem, "select fn_set_channel_routing($1,$2,$3,$4) result", [org, canal, [], true]);

const regraDoNumero = async () =>
  (await query(
    "select distribution_mode, default_assignee_user_id, ai_wait_minutes, sector_id, has_manager_rule from channel_routing_policies where organization_id=$1 and channel_session_id=$2",
    [org, canal],
  )).rows[0] ?? null;

const responsaveis = async () =>
  (await query(
    "select count(*)::int n from channel_routing_responsibles where organization_id=$1",
    [org],
  )).rows[0].n as number;

/** O número com regra de gestor E com os dois campos de admin preenchidos. */
async function numeroComFilaEEspera() {
  const fila = (await query(
    "insert into attendant_sectors (organization_id, name) values ($1,$2) returning id",
    [org, "Fila do reset"],
  )).rows[0].id as string;
  await asUser(manager, "select fn_set_channel_routing($1,$2,$3,false,$4,$5) result", [org, canal, [atendente], "round_robin", atendente]);
  await query(
    "update channel_routing_policies set ai_wait_minutes=30, sector_id=$3 where organization_id=$1 and channel_session_id=$2",
    [org, canal, fila],
  );
  return fila;
}

beforeAll(() => seedGov());
afterAll(() => pool.end());
beforeEach(async () => {
  await query("delete from channel_routing_responsibles where organization_id=$1", [org]);
  await query("delete from channel_routing_policies where organization_id=$1", [org]);
  await query("update conversations set assigned_to_user_id=null,assignee_kind=null,status='open' where organization_id=$1", [org]);
  await query(
    "insert into attendant_availability(organization_id,user_id,is_available,capacity,schedule) values($1,$2,true,1,'{}') on conflict(organization_id,user_id) do update set is_available=true,capacity=1,schedule='{}'",
    [org, atendente],
  );
});

describe("reset de manager preserva a regra de admin (#5381)", () => {
  it("gestor reseta: espera da IA e fila continuam, e o número volta à organização", async () => {
    const fila = await numeroComFilaEEspera();
    expect(await regraDoNumero()).toMatchObject({
      distribution_mode: "round_robin",
      default_assignee_user_id: atendente,
      ai_wait_minutes: 30,
      sector_id: fila,
      has_manager_rule: true,
    });
    expect(await responsaveis()).toBe(1);

    await resetar(manager);

    expect(await regraDoNumero()).toMatchObject({
      distribution_mode: null,
      default_assignee_user_id: null,
      ai_wait_minutes: 30,
      sector_id: fila,
      has_manager_rule: false,
    });
    expect(await responsaveis()).toBe(0);
    // A linha que sobra não é lista de ninguém: o claim volta a distribuir pela
    // organização em vez de recusar todo mundo com `candidate_not_allowed`.
    const claim = await query("select fn_channel_routing_claim($1,$2,$3,$4,'{}') result", [org, conversa, canal, atendente]);
    expect(claim.rows[0].result).toBe("assigned");
  });

  it("admin reseta o mesmo número: a regra some inteira", async () => {
    await numeroComFilaEEspera();
    expect(await regraDoNumero()).not.toBeNull();

    await resetar(admin);

    expect(await regraDoNumero()).toBeNull();
    expect(await responsaveis()).toBe(0);
  });
});
