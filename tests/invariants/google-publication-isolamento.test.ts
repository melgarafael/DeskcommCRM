import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

if (!process.env.TEST_DB_CONTAINER) throw new Error('rode via pnpm test:db');
const pool = new pg.Pool({
  connectionString: process.env.TEST_DB_URL ?? `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 2,
});
const tenants = [0, 1].map(() => ({ org: randomUUID(), user: randomUUID(), session: randomUUID(), contact: randomUUID(), conversation: randomUUID(), job: randomUUID(), receipt: randomUUID() }));
beforeAll(async () => {
  for (const t of tenants) {
    await pool.query("insert into auth.users(id,email) values($1,$2)", [t.user, `${t.user}@invariant.test`]);
    await pool.query("insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Google isolation','Google isolation')", [t.org]);
    await pool.query("insert into user_organizations(user_id,organization_id,role,accepted_at) values($1,$2,'agent',now())", [t.user, t.org]);
    await pool.query("insert into channel_sessions(id,organization_id,waha_session_name,webhook_secret_encrypted) values($1::uuid,$2,$1::text,'\\x00'::bytea)", [t.session, t.org]);
    await pool.query("insert into contacts(id,organization_id,display_name) values($1,$2,'Synthetic contact')", [t.contact, t.org]);
    await pool.query("insert into conversations(id,organization_id,contact_id,channel_session_id) values($1,$2,$3,$4)", [t.conversation, t.org, t.contact, t.session]);
    await pool.query("insert into job_queue(id,organization_id,contact_id,kind,payload) values($1,$2,$3,'inbound_turn',$4)", [t.job, t.org, t.contact, { conversation_id: t.conversation }]);
    await pool.query("insert into google_publication_continuations(id,organization_id,contact_id,conversation_id,source_job_id,operation_key,appointment_ids,revisions,service_boundary) values($1,$2,$3,$4,$5,'isolation',array[]::uuid[],'{}','{}')", [t.receipt, t.org, t.contact, t.conversation, t.job]);
  }
});
afterAll(async () => {
  await pool.query('delete from organizations where id=any($1::uuid[])', [tenants.map(t => t.org)]);
  await pool.query('delete from auth.users where id=any($1::uuid[])', [tenants.map(t => t.user)]);
  await pool.end();
});

describe('continuidade Google: recibo do servidor com RLS entre organizações', () => {
  it('tem duas linhas reais e mantém a leitura nativa do serviço', async () => {
    const db = await pool.connect();
    try {
      await db.query('begin');
      await db.query('set local role service_role');
      for (const t of tenants) expect((await db.query('select count(*)::int n from google_publication_continuations where id=$1 and organization_id=$2', [t.receipt, t.org])).rows[0].n).toBe(1);
    } finally { await db.query('rollback'); db.release(); }
  });

  it.each(['anon', 'authenticated'] as const)('%s não lê nem escreve diretamente, mesmo com JWT legítimo', async role => {
    for (const t of tenants) {
      const queries = [
        'select * from google_publication_continuations where id=$1',
        "update google_publication_continuations set state='stale' where id=$1",
        'delete from google_publication_continuations where id=$1',
        'insert into google_publication_continuations select * from google_publication_continuations where id=$1',
      ];
      for (const query of queries) {
        const db = await pool.connect();
        try {
          await db.query('begin');
          await db.query(`set local role ${role}`);
          await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: t.user, role })]);
          await expect(db.query(query, [t.receipt])).rejects.toMatchObject({ code: '42501' });
        } finally { await db.query('rollback'); db.release(); }
      }
    }
  });

  it.each([0, 1])('policy deixa a organização %s ver só sua linha, com GRANT temporário revertido', async index => {
    const own = tenants[index]!, foreign = tenants[1 - index]!;
    const db = await pool.connect();
    try {
      await db.query('begin');
      // Só nesta transação de prova: não abrir a API pública para satisfazer TABLES.
      await db.query('grant select on google_publication_continuations to authenticated');
      await db.query('set local role authenticated');
      await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: own.user, role: 'authenticated' })]);
      expect((await db.query('select count(*)::int n from google_publication_continuations where organization_id=$1', [own.org])).rows[0].n).toBe(1);
      expect((await db.query('select count(*)::int n from google_publication_continuations where organization_id=$1', [foreign.org])).rows[0].n).toBe(0);
      expect((await db.query('select count(*)::int n from google_publication_continuations')).rows[0].n).toBe(1);
    } finally { await db.query('rollback'); db.release(); }
    expect((await pool.query("select has_table_privilege('authenticated','google_publication_continuations','select') allowed")).rows[0].allowed).toBe(false);
  });

  it('revogar o vínculo retira a leitura pela policy sem conceder privilégio permanente', async () => {
    const t = tenants[0]!;
    const db = await pool.connect();
    try {
      await db.query('begin');
      await db.query('grant select on google_publication_continuations to authenticated');
      await db.query('delete from user_organizations where user_id=$1 and organization_id=$2', [t.user, t.org]);
      await db.query('set local role authenticated');
      await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: t.user, role: 'authenticated' })]);
      expect((await db.query('select count(*)::int n from google_publication_continuations')).rows[0].n).toBe(0);
    } finally { await db.query('rollback'); db.release(); }
  });
});
