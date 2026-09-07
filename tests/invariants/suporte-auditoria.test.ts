import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { pgComoSupabase } from "../pg-como-supabase";

// Só transporte/auth de request são substituídos. audit() e seu INSERT são reais.
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => database }));
vi.mock("@/lib/supabase/server", () => ({ createClient: () => { throw new Error("Callback sem cookie JWT"); } }));
vi.mock("@/lib/env", async (original) => {
  const originalModule = await original<typeof import("@/lib/env")>();
  return { ...originalModule, env: { ...originalModule.env, SUPABASE_SERVICE_ROLE_KEY: "local-test-admin" } };
});
const pool = new pg.Pool({connectionString:`postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,max:2});
const database = pgComoSupabase(pool);
const actor=randomUUID(), organization=randomUUID(), session=randomUUID(), support=randomUUID();
beforeAll(async()=>{
 await pool.query("insert into auth.users(id) values($1)",[actor]);
 await pool.query("insert into organizations(id,slug,display_name,legal_name) values($1,$2,'Suporte audit','Suporte audit')",[organization,`support-audit-${organization}`]);
 await pool.query("insert into platform_support_sessions(id,organization_id,actor_user_id,auth_session_id,access_mode,expires_at) values($1,$2,$3,$4,'full',now()+interval '1 hour')",[support,organization,actor,session]);
});
afterAll(async()=>{await pool.query("delete from organizations where id=$1",[organization]);await pool.query("delete from auth.users where id=$1",[actor]);await pool.end();});
for(const action of ["agenda.google.conexao_concluida","nuvemshop.connected"] as const) it(`${action}: registro persistido liga ator/state/suporte sem JWT`,async()=>{
 const {audit}=await import("@/lib/audit");const request=randomUUID();
 await audit({action,actorUserId:actor,actorAuthSessionId:session,organizationId:organization,requestId:request});
 const {rows}=await pool.query("select actor_user_id,organization_id,metadata,acting_as_platform_admin from api_audit_log where request_id=$1",[request]);
 expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({actor_user_id:actor,organization_id:organization,acting_as_platform_admin:true,metadata:{support_session_id:support,support_auth_session_id:session,support_access_mode:"full"}});
});
it("outra sessão do mesmo ator não herda a atribuição de suporte",async()=>{
 const {audit}=await import("@/lib/audit");const request=randomUUID();
 await audit({action:"nuvemshop.connected",actorUserId:actor,actorAuthSessionId:randomUUID(),organizationId:organization,requestId:request});
 const {rows}=await pool.query("select actor_user_id,metadata,acting_as_platform_admin from api_audit_log where request_id=$1",[request]);
 expect(rows).toHaveLength(1);expect(rows[0].actor_user_id).toBe(actor);expect(rows[0].metadata.support_session_id).toBeUndefined();expect(rows[0].acting_as_platform_admin).toBe(false);
});
