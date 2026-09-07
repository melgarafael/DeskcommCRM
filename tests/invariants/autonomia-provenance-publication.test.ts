import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,it,expect} from 'vitest';
import {seedGov} from './gov-helpers';
import {replyFixture} from '../support/autonomia-fixture';
const pool=new pg.Pool({connectionString:`postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT??54329}/postgres`,max:5});
beforeAll(()=>seedGov());afterAll(()=>pool.end());
async function setup(){
 const f=await replyFixture(pool);
 await pool.query('update ai_agents set published_version_id=null where id=$1',[f.agent]);
 await pool.query('delete from ai_agent_versions where id=$1',[f.version]);
 await pool.query("insert into ai_agent_versions(id,organization_id,agent_id,version_number,system_prompt,provider,model,channel_session_id,provisioning_origin) values($1,$2,$3,1,'Tentativa própria','anthropic','test-model',$4,'legacy_reconciliation')",[f.version,f.org,f.agent,f.channel]);
 return f;
}
it('edição humana entre observação e publicação é revalidada sob lock da versão',async()=>{
 const f=await setup(),writer=await pool.connect(),publisher=await pool.connect();
 let publishing:Promise<pg.QueryResult>|undefined;
 try{
  expect((await pool.query('select provisioning_origin from ai_agent_versions where id=$1',[f.version])).rows[0].provisioning_origin).toBe('legacy_reconciliation');
  await writer.query('begin');await writer.query('select id from ai_agent_versions where id=$1 for update',[f.version]);
  publishing=publisher.query("select * from fn_publish_ai_agent_version($1,$2,$3,true,'legacy_reconciliation')",[f.org,f.agent,f.version]);
  const failure=expect(publishing).rejects.toThrow('existing_version_requires_review');
  await writer.query("update ai_agent_versions set system_prompt='Edição humana' where id=$1",[f.version]);
  await writer.query('commit');await failure;
  expect((await pool.query('select published_version_id from ai_agents where id=$1',[f.agent])).rows[0].published_version_id).toBeNull();
 }finally{await writer.query('rollback');await publishing?.catch(()=>{});writer.release();publisher.release();}
});
it('segunda versão humana após observação impede a retomada automática da própria tentativa',async()=>{
 const f=await setup();
 expect((await pool.query('select count(*)::int n from ai_agent_versions where agent_id=$1',[f.agent])).rows[0].n).toBe(1);
 await pool.query("insert into ai_agent_versions(id,organization_id,agent_id,version_number,system_prompt,provider,model,channel_session_id) values($1,$2,$3,2,'Draft humano','anthropic','test-model',$4)",[randomUUID(),f.org,f.agent,f.channel]);
 await expect(pool.query("select * from fn_publish_ai_agent_version($1,$2,$3,true,'legacy_reconciliation')",[f.org,f.agent,f.version])).rejects.toThrow('existing_version_requires_review');
 expect((await pool.query('select published_version_id from ai_agents where id=$1',[f.agent])).rows[0].published_version_id).toBeNull();
});
