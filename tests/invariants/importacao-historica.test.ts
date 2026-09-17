import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";

if (!process.env.TEST_DB_CONTAINER) throw new Error("Rode via pnpm test:db");
const db = new pg.Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres` });
afterAll(() => db.end());

describe("Importação histórica", () => {
  it("exige administrador SQL, lote aberto e organização correspondente", async () => {
    const c = await db.connect();
    const org = randomUUID(), batch = randomUUID();
    try {
      await c.query("begin");
      await c.query("insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Teste','Teste')", [org]);
      await c.query("insert into data_import_batches(id,organization_id,source,source_workspace_id,source_cutoff) values($1,$2,'test','test',now())", [batch,org]);
      await c.query("select set_config('crm.historical_import_batch',$1,true)", [batch]);
      expect((await c.query("select fn_historical_import_allowed($1) allowed", [org])).rows[0].allowed).toBe(true);
      expect((await c.query("select fn_historical_import_allowed($1) allowed", [randomUUID()])).rows[0].allowed).toBe(false);
      for (const role of ["authenticated", "service_role"]) {
        await c.query(`set local role ${role}`);
        expect((await c.query("select fn_historical_import_allowed($1) allowed", [org])).rows[0].allowed).toBe(false);
        await c.query("reset role");
      }
      await c.query("update data_import_batches set status='completed' where id=$1", [batch]);
      expect((await c.query("select fn_historical_import_allowed($1) allowed", [org])).rows[0].allowed).toBe(false);
    } finally { await c.query("rollback"); c.release(); }
  });

  it("gestor consulta arquivo e anexos da própria organização; agente não lê arquivo nem nota restrita", async () => {
    const c = await db.connect();
    const org = randomUUID(), other = randomUUID(), manager = randomUUID(), agent = randomUUID(), outsider = randomUUID();
    const batch = randomUUID(), contact = randomUUID(), session = randomUUID(), conv = randomUUID(), message = randomUUID(), record = randomUUID();
    try {
      await c.query("begin");
      for (const id of [org,other]) await c.query("insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Teste','Teste')", [id]);
      for (const [id,organization,role] of [[manager,org,"manager"],[agent,org,"agent"],[outsider,other,"manager"]]) {
        await c.query("insert into auth.users(id) values($1)", [id]);
        await c.query("insert into user_organizations(user_id,organization_id,role,accepted_at) values($1,$2,$3,now())", [id,organization,role]);
      }
      await c.query("insert into data_import_batches(id,organization_id,source,source_workspace_id,source_cutoff) values($1,$2,'test','test',now())", [batch,org]);
      await c.query("select set_config('crm.historical_import_batch',$1,true)", [batch]);
      await c.query("insert into contacts(id,organization_id,name) values($1,$2,'Teste')", [contact,org]);
      await c.query("insert into channel_sessions(id,organization_id,provider,status,webhook_secret_encrypted) values($1,$2,'historical','STOPPED','\\x')", [session,org]);
      await c.query("insert into conversations(id,organization_id,contact_id,channel_session_id) values($1,$2,$3,$4)", [conv,org,contact,session]);
      await c.query("insert into messages(id,organization_id,contact_id,conversation_id,channel_session_id,type,direction,status) values($1,$2,$3,$4,$5,'text','outbound','unknown')", [message,org,contact,conv,session]);
      await c.query("insert into message_attachments(organization_id,message_id,position,availability) values($1,$2,0,'unavailable')", [org,message]);
      await c.query("insert into data_import_records(id,organization_id,batch_id,source_table,source_id,source_data,contact_id) values($1,$2,$3,'test','test','{}',$4)", [record,org,batch,contact]);
      await c.query("insert into data_import_record_contacts values($1,$2,$3)", [org,record,contact]);
      await c.query("insert into conversation_notes(organization_id,conversation_id,body,visibility_scope) values($1,$2,'Teste','managers_only')", [org,conv]);
      expect((await c.query("select count(*)::int n from event_log where organization_id=$1", [org])).rows[0].n).toBe(0);
      for (const [user,archiveCount,attachmentCount] of [[manager,1,1],[agent,0,1],[outsider,0,0]] as const) {
        await c.query("select set_config('request.jwt.claim.sub',$1,true)", [user]);
        await c.query("set local role authenticated");
        for (const table of ["data_import_batches","data_import_records","data_import_record_contacts","conversation_notes"]) {
          expect((await c.query(`select count(*)::int n from ${table} where organization_id=$1`, [org])).rows[0].n).toBe(archiveCount);
        }
        expect((await c.query("select count(*)::int n from message_attachments where organization_id=$1", [org])).rows[0].n).toBe(attachmentCount);
        await c.query("reset role");
      }
      await c.query("update contacts set is_anonymized=true,anonymized_at=now() where id=$1", [contact]);
      expect((await c.query("select source_data from data_import_records where id=$1", [record])).rows[0].source_data).toEqual({redacted:true});
      expect((await c.query("select count(*)::int n from message_attachments where message_id=$1", [message])).rows[0].n).toBe(0);
    } finally { await c.query("rollback"); c.release(); }
  });
});
