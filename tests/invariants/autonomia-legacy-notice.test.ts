import pg from 'pg';
import {beforeAll,afterAll,it,expect} from 'vitest';
import {seedGov} from './gov-helpers';
import {replyFixture} from '../support/autonomia-fixture';
const pool=new pg.Pool({connectionString:`postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT??54329}/postgres`,max:5});
beforeAll(()=>seedGov());afterAll(()=>pool.end());
it('Central deduplica cada transição, mantém causa acionável e encerra após recuperação',async()=>{
 const f=await replyFixture(pool);
 await pool.query("update ai_agents set published_version_id=null where id=$1",[f.agent]);
 const notice=async(code:string)=>(await pool.query("select fn_agent_legacy_notice($1,$2,$3,'Configuração pendente','Abra IA > Agentes > Recuperar') created",[f.org,f.agent,code])).rows[0].created;
 expect((await Promise.all([notice('sem_versao'),notice('sem_versao')])).filter(Boolean)).toHaveLength(1);
 expect(await notice('sem_credencial')).toBe(true);
 expect(await notice('sem_versao')).toBe(false);
 await pool.query("update agent_inbox_items set status='ack' where organization_id=$1 and status='open'",[f.org]);
 expect(await notice('sem_credencial')).toBe(false);
 await pool.query('update ai_agents set published_version_id=$1 where id=$2',[f.version,f.agent]);
 expect(await notice('pronto')).toBe(false);
 expect(await notice('sem_versao')).toBe(false); // Snapshot do worker anterior à publicação.

 expect((await pool.query("select count(*)::int n from agent_inbox_items where organization_id=$1 and status in('open','ack')",[f.org])).rows[0].n).toBe(0);
 await pool.query('update ai_agents set published_version_id=null where id=$1',[f.agent]);
 expect(await notice('sem_versao')).toBe(true);
 expect((await pool.query("select count(*)::int n from agent_inbox_items where organization_id=$1",[f.org])).rows[0].n).toBe(4);
 expect((await pool.query("select count(*)::int n from messages where organization_id=$1",[f.org])).rows[0].n).toBe(0);
});
