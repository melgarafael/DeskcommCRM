import type pg from "pg";
import type { ServiceBoundary } from "@/lib/atendimento/fronteira";

/** Origem real na CRIAÇÃO da fixture, nunca retrofit de enrollment legado. */
export async function criarOrigemDeFollowup(pool: pg.Pool, org: string, contact: string): Promise<ServiceBoundary> {
  const session = (await pool.query("select id from channel_sessions where organization_id=$1 and archived_at is null order by id limit 1", [org])).rows[0]?.id;
  if (!session) await pool.query("insert into channel_sessions(organization_id,waha_session_name,status,webhook_secret_encrypted) values($1,gen_random_uuid()::text,'WORKING',decode('00','hex')) returning id", [org]);
  const result = (await pool.query("select fn_service_begin($1,$2) boundary", [org,contact])).rows[0].boundary;
  const { status: _status, demanda_fechada_em: _closed, service_started_at: _started, ...boundary } = result;
  return boundary;
}
