import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,it,expect} from 'vitest';
import {seedGov} from './gov-helpers';
import {replyFixture} from '../support/autonomia-fixture';
const pool=new pg.Pool({connectionString:`postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT??54329}/postgres`});
beforeAll(()=>seedGov());afterAll(()=>pool.end());
it('proveniência só acompanha a tentativa própria intocada e não pode ser recolocada por edição',async()=>{
 const f=await replyFixture(pool),id=randomUUID(),humanDraft=randomUUID();
 await pool.query("insert into ai_agent_versions(id,organization_id,agent_id,version_number,system_prompt,provider,model,status,provisioning_origin,channel_session_id) values($1,$2,$3,2,'Original','anthropic','test-model','draft','legacy_reconciliation',$4)",[id,f.org,f.agent,f.channel]);
 const origin=async(versionId=id)=>(await pool.query('select provisioning_origin from ai_agent_versions where id=$1',[versionId])).rows[0].provisioning_origin;
 expect(await origin()).toBe('legacy_reconciliation');
 await pool.query("update ai_agent_versions set status='published',published_at=now() where id=$1",[id]);
 expect(await origin()).toBe('legacy_reconciliation');
 await expect(pool.query("update ai_agent_versions set system_prompt='Alterado por uma pessoa' where id=$1",[id])).rejects.toThrow('imutável');
 expect(await origin()).toBe('legacy_reconciliation');
 // A intervenção humana altera um draft novo; a versão publicada continua imutável.
 await pool.query("insert into ai_agent_versions(id,organization_id,agent_id,version_number,system_prompt,provider,model,status,provisioning_origin,channel_session_id) values($1,$2,$3,3,'Original','anthropic','test-model','draft','legacy_reconciliation',$4)",[humanDraft,f.org,f.agent,f.channel]);
 expect(await origin(humanDraft)).toBe('legacy_reconciliation');
 await pool.query("update ai_agent_versions set system_prompt='Alterado por uma pessoa' where id=$1",[humanDraft]);
 expect(await origin(humanDraft)).toBeNull();
 await pool.query("update ai_agent_versions set provisioning_origin='legacy_reconciliation' where id=$1",[humanDraft]);
 expect(await origin(humanDraft)).toBeNull();
});
