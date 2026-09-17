import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { childEnvironment, readContext } from '../common.mjs';
import { connectEventsDatabase } from './connection.mjs';

function worker(context,schema,eventId) {
  const child=fork(fileURLToPath(new URL('./worker.mjs',import.meta.url)),[],{
    stdio:['ignore','ignore','ignore','ipc'],execArgv:[],env:childEnvironment(),
  });
  const exit=once(child,'exit');
  const first=once(child,'message',{signal:AbortSignal.timeout(5000)});
  child.send({context,schema,eventId,mode:'resume'});
  return {child,exit,first};
}

test('Conexões de eventos, receiver e worker usam cliente atestado antes da fixture', {timeout:15000}, async () => {
  const context=await readContext(process.cwd());
  const schema=`bench_events_${randomUUID().replaceAll('-','')}`;
  const clients=[];
  const children=[];
  let server;
  try {
    // Mesmos quatro papéis de conexão física usados pelo probe, sem repetir benchmark.
    for(let i=0;i<4;i++) clients.push(await connectEventsDatabase(context,schema));
    const identities=await Promise.all(clients.map(async client=>(await client.query(`
      select pg_backend_pid() as pid, current_database() as database,
      current_user as role, current_setting('search_path') as path`)).rows[0]));
    assert.equal(new Set(identities.map(row=>row.pid)).size,4);
    for(const identity of identities) {
      assert.equal(identity.database,'extensions_bench');
      assert.equal(identity.role,'extensions_bench_owner');
      assert.equal(identity.path,`${schema},pg_catalog`);
    }
    const [origin,consumer,observer,receiverDb]=clients;
    await origin.query(`create schema ${schema}`);
    await origin.query(`revoke all on schema ${schema} from public`);
    await origin.query(`create table event_log(id uuid primary key,organization_id uuid not null,event_type text not null)`);
    await origin.query(await readFile(new URL('./fixture.sql',import.meta.url),'utf8'));
    const eventId=randomUUID();
    const orgId=randomUUID();
    await origin.query(`insert into subscriptions values('connection-check',1,$1,'contact.updated','local-a','0.0.1-bench')`,[orgId]);
    await origin.query(`insert into event_log values($1,$2,'contact.updated')`,[eventId,orgId]);
    const receipt=(await consumer.query(`insert into receipts(event_id,organization_id,subscription_id,
      subscription_revision,destination,version) values($1,$2,'connection-check',1,'local-a','0.0.1-bench') returning id`,[eventId,orgId])).rows[0];
    const resumed=worker(context,schema,eventId); children.push(resumed.child);
    const [reclaimed]=await resumed.first;
    assert.equal(reclaimed.phase,'reclaimed');
    const finished=once(resumed.child,'message',{signal:AbortSignal.timeout(5000)});
    resumed.child.send({action:'finish'});
    const [completion]=await finished;
    assert.equal(completion.finished,true);
    assert.equal((await resumed.exit)[0],0);
    assert.equal((await observer.query('select count(*)::int as n from local_effects')).rows[0].n,1);

    // O mesmo worker precisa rejeitar contexto divergente, antes de reclamar recibos.
    const rejected=worker({...context,databaseUrl:context.databaseUrl.replace('/extensions_bench','/extensions_foreign')},schema,eventId);
    children.push(rejected.child);
    const [failure]=await rejected.first;
    assert.equal(typeof failure.error,'string');
    assert.equal((await rejected.exit)[0],1);
    assert.equal((await observer.query('select attempts from receipts where id=$1',[receipt.id])).rows[0].attempts,1);

    let receiverError;
    server=createServer(async (req,res)=>{
      req.resume();
      try {
        await receiverDb.query('insert into external_effects(receipt_id) values($1)',[receipt.id]);
        res.end('confirmed');
      } catch(error) { receiverError=error; req.socket.destroy(); }
    });
    server.listen(0,'127.0.0.1'); await once(server,'listening');
    const response=await fetch(`http://127.0.0.1:${server.address().port}`,{method:'POST',signal:AbortSignal.timeout(5000)});
    assert.equal(await response.text(),'confirmed');
    assert.equal(receiverError,undefined);
    assert.equal((await observer.query('select requests from external_effects where receipt_id=$1',[receipt.id])).rows[0].requests,1);
  } finally {
    for(const child of children) { if(child.exitCode===null && child.signalCode===null) child.kill('SIGKILL'); }
    if(server) { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
    const closed=await Promise.allSettled(clients.map(client=>client.end()));
    for(const result of closed) if(result.status==='rejected') throw result.reason;
  }
});
