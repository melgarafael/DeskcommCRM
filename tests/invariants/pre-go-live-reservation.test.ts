import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { metadataInicialDoCanal } from "../../lib/ai/elegibilidade/pre-go-live";

if (!process.env.TEST_DB_CONTAINER) throw new Error("Rode via pnpm test:db");
const pool = new Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres` });
const actor = randomUUID();
beforeAll(async () => {
  await pool.query("insert into auth.users(id,email) values($1,$2)", [actor, `reservation-${actor}@invariant.test`]);
});
afterAll(() => pool.end());

async function reserve(org: string, key: string, onboarding: boolean) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({sub:actor,aal:"aal1"})]);
    const result = await client.query("select fn_reserve_channel_connection($1,$2,$3,null,$4) result", [org,key,"a".repeat(64),onboarding]);
    await client.query("commit");return result.rows[0].result;
  } catch (error) { await client.query("rollback");throw error; }
  finally { client.release(); }
}

describe("reserva WAHA preserva pré-go-live da main", () => {
  it.each([false,true])("canal novo onboarding=%s fechado; retry conserva decisão posterior", async (onboarding) => {
    const org=randomUUID(),key=randomUUID();
    await pool.query("insert into organizations(id,slug,legal_name,display_name) values($1,$2,'Reserva','Reserva')",[org,org]);
    await pool.query("insert into user_organizations(organization_id,user_id,role,accepted_at) values($1,$2,'admin',now())",[org,actor]);
    const first=await reserve(org,key,onboarding);
    expect(first.channel.organization_id).toBe(org);
    expect(first.channel.metadata).toEqual({...metadataInicialDoCanal(),...(onboarding?{onboarding:true}:{})});
    await pool.query("select fn_finish_channel_connection($1,$2,$3,'FAILED','connection_repair_required')",[org,first.receipt_id,first.lease_token]);
    // Mudança explícita do operador não pode ser desfeita por retry de conexão.
    const mode=onboarding?"pre_go_live":"open";
    await pool.query("select fn_configurar_pre_go_live_canal($1,$2,$3,$4)",[org,first.channel.id,mode,["+5511987654321"]]);
    await pool.query("update channel_sessions set metadata=metadata||'{\"transport\":{\"keep\":true}}'::jsonb where organization_id=$1 and id=$2",[org,first.channel.id]);
    const before=(await pool.query("select metadata from channel_sessions where organization_id=$1 and id=$2",[org,first.channel.id])).rows[0].metadata;
    expect(before.ai_gate).toBe(onboarding?"allowlist":"open");
    expect(before.ai_test_phone_numbers).toEqual(["+5511987654321"]);
    const retry=await reserve(org,key,onboarding);
    expect(retry.channel.id).toBe(first.channel.id);
    expect(retry.channel.waha_session_name).toBe(first.channel.waha_session_name);
    expect(retry.lease_token).not.toBe(first.lease_token);
    expect(retry.channel.metadata).toEqual(before);
  });
});
