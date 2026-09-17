import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer, request } from 'node:http';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { claim, finishLocal } from './worker.mjs';
import { readContext, childEnvironment, writeJsonAtomic } from '../common.mjs';
import { connectEventsDatabase } from './connection.mjs';

const ORG = '00000000-0000-4000-8000-000000000001';
const ORG_OTHER = '00000000-0000-4000-8000-000000000002';
// Parâmetros definidos ANTES de medir. São desenho do ensaio, nunca SLA do CRM.
const PLAN = Object.freeze({ repetitions: 3, warmupPerMode: 20, batches: 5,
  insertsPerBatch: 100, localLeaseMs: 200, httpTimeoutMs: 1000,
  lockObservationTimeoutMs: 2000, statementTimeoutMs: 5000 });
const MIGRATION = 'supabase/migrations/20260912200000_0239_registro_nao_fica_pendente.sql';

function check(report, id, name, passed, observed) {
  report.checks.push({ id, name, passed: Boolean(passed), observed });
}

async function insertEvent(client, type = 'contact.updated', organization = ORG) {
  const result = await client.query(`insert into event_log(organization_id,event_type,entity_kind,payload)
    values($1,$2,'contact','{"synthetic":true}') returning *`, [organization, type]);
  return result.rows[0];
}

async function fanout(client, eventId) {
  // Fan-out e marcação são atômicos. Repetir explicitamente também é seguro pela unique.
  await client.query('begin');
  try {
    await client.query('select event_id from outbox where event_id=$1 for update', [eventId]);
    await client.query(`insert into receipts(event_id,organization_id,subscription_id,
      subscription_revision,destination,version)
      select o.event_id,o.organization_id,s.id,s.revision,s.destination,s.version
      from outbox o join event_log e on e.id=o.event_id
      join subscriptions s on s.organization_id=o.organization_id
        and s.revision=o.subscriptions_revision and s.event_type=e.event_type
      where o.event_id=$1 on conflict do nothing`, [eventId]);
    await client.query('update outbox set expanded=true where event_id=$1', [eventId]);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}

function startChild(context, schema, eventId, mode) {
  const child = fork(fileURLToPath(new URL('./worker.mjs', import.meta.url)), [],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: [], env: childEnvironment() });
  const exit = once(child, 'exit');
  const message = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Subprocesso excedeu 5s.')); }, 5000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Subprocesso saiu sem resposta (${code}).`)); });
    child.once('message', value => {
      clearTimeout(timer);
      if (value.error) reject(new Error(value.error)); else resolve(value);
    });
  });
  child.send({ context, schema, eventId, mode });
  return { child, message, exit };
}

function post(port, path, receiptId) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method: 'POST',
      headers: { 'x-receipt-id': receiptId } }, res => {
      res.resume();
      res.once('end', () => resolve(res.statusCode));
    });
    const timer = setTimeout(() => req.destroy(new Error('Tempo experimental de HTTP excedido.')), PLAN.httpTimeoutMs);
    req.once('close', () => clearTimeout(timer));
    req.once('error', reject);
    req.end();
  });
}

async function markSending(client, receipt) {
  const result = await client.query(`update receipts set state='sending'
    where id=$1 and state='processing' and lease_token=$2 and lease_until>clock_timestamp()
    returning id`, [receipt.id, receipt.lease_token]);
  if (result.rowCount !== 1) throw new Error('Perdeu autoridade antes de enviar.');
}

function summarize(samples) {
  const sorted = [...samples].sort((a,b) => a-b);
  return { n: samples.length, meanMs: samples.reduce((a,b)=>a+b,0)/samples.length,
    p50Ms: sorted[Math.ceil(sorted.length*0.5)-1], p95Ms: sorted[Math.ceil(sorted.length*0.95)-1],
    maxMs: sorted.at(-1) };
}

async function measureInserts(client) {
  const result = { withoutCapture: [], withCapture: [], batchOrder: [] };
  for (const enabled of [false,true]) {
    await client.query(`alter table event_log ${enabled?'enable':'disable'} trigger capture_extension_event`);
    for (let i=0;i<PLAN.warmupPerMode;i++) await insertEvent(client);
  }
  for (let batch=0;batch<PLAN.batches;batch++) {
    for (const enabled of batch%2 ? [true,false] : [false,true]) {
      const mode = enabled?'withCapture':'withoutCapture';
      result.batchOrder.push(mode);
      await client.query(`alter table event_log ${enabled?'enable':'disable'} trigger capture_extension_event`);
      for (let i=0;i<PLAN.insertsPerBatch;i++) {
        const started = performance.now();
        await insertEvent(client);
        result[mode].push(performance.now()-started);
      }
    }
  }
  await client.query('alter table event_log enable trigger capture_extension_event');
  return { samplesMs: result, withoutCapture: summarize(result.withoutCapture),
    withCapture: summarize(result.withCapture),
    meanOverheadMs: summarize(result.withCapture).meanMs-summarize(result.withoutCapture).meanMs };
}

export async function runProbe({ databaseUrl, repoRoot, evidenceDir }) {
  const report = { id: 'events', status: 'failed', startedAt: new Date().toISOString(), environment: {
    platform: `${process.platform}-${process.arch}`, node: process.version }, checks: [],
    measurements: { plan: PLAN }, limitations: [
      'Prova de mecanismo com fixture SQL e HTTP loopback; não mede a jornada pela tela nem integração completa ao CRM.',
      'Não aplica o baseline completo, Supabase Auth/RLS, Realtime, emit_event atual ou drenos reais; exige prova posterior no piso pg15 e no CRM.',
      'Assinaturas sintéticas fixas na revisão 1; não prova atualização, autorização, retenção, anonimização, suspensão nem escalonamento justo sob carga.',
      'Lease recupera apenas efeito local atômico. Resultado externo incerto exige consulta ao receptor ou tarefa humana; não há exatamente uma vez externo.',
      'Latência inclui cliente Node, round-trip loopback e commit; amostra local pequena, sem carga de produção ou orçamento de desempenho aprovado.'
    ] };
  const context = { databaseUrl, repoRoot, evidenceDir };
  const clients = [];
  let schema;
  try {
    if (!databaseUrl) {
      report.status = 'blocked';
      report.limitations.push('Banco exclusivo não informado.');
      return report;
    }
    const url = new URL(databaseUrl);
    if (!['postgres:','postgresql:'].includes(url.protocol) || !['127.0.0.1','[::1]'].includes(url.hostname)
        || url.search || url.hash) throw new Error('Banco deve usar IP literal de loopback, sem opções de URL.');
    schema = `bench_events_${randomUUID().replaceAll('-','')}`;
    const client = await connectEventsDatabase(context,schema,PLAN.statementTimeoutMs); clients.push(client);
    const other = await connectEventsDatabase(context,schema,PLAN.statementTimeoutMs); clients.push(other);
    const observer = await connectEventsDatabase(context,schema,PLAN.statementTimeoutMs); clients.push(observer);
    const receiverDb = await connectEventsDatabase(context,schema,PLAN.statementTimeoutMs); clients.push(receiverDb);
    report.environment.postgres = (await client.query('select version() as version')).rows[0].version;
    report.environment.schema = schema;
    await client.query(`create schema ${schema}`);
    await client.query(`revoke all on schema ${schema} from public`);
    const baseline = await readFile(join(repoRoot,'supabase/baseline.sql'),'utf8');
    const migration = await readFile(join(repoRoot,MIGRATION),'utf8');
    const ddl = baseline.match(/CREATE TABLE IF NOT EXISTS "public"\."event_log" \([\s\S]*?\n\);/)?.[0];
    if (!ddl) throw new Error('DDL event_log não encontrada no baseline.');
    const start = migration.indexOf('create or replace function public.fn_event_log_e_registro');
    if (start < 0) throw new Error('Migration 0239 não contém a semântica esperada.');
    const mappedMigration = migration.slice(start)
      .replaceAll('public.',`${schema}.`).replaceAll("'public', 'pg_temp'",`'${schema}', 'pg_temp'`)
      .replace(/^(revoke|grant|notify) .*;\n?/gm,'');
    await client.query(ddl.replaceAll('"public".',`"${schema}".`));
    await client.query('alter table event_log add primary key (id)');
    await client.query(mappedMigration);
    await client.query(await readFile(new URL('./fixture.sql',import.meta.url),'utf8'));
    report.measurements.source = { migration: MIGRATION,
      migrationSha256: createHash('sha256').update(migration).digest('hex'),
      eventLogDdlSha256: createHash('sha256').update(ddl).digest('hex'),
      transformation: 'DDL event_log integral + PK; 0239 integral desde a primeira função, apenas schema/search_path remapeados e linhas revoke/grant/notify omitidas.' };
    await mkdir(evidenceDir,{recursive:true});
    await writeFile(join(evidenceDir,'events-applied-0239.sql'),mappedMigration);
    for (const type of ['contact.updated','message.send_requested']) {
      for (const destination of ['local-a','local-b','external']) {
        await client.query(`insert into subscriptions values($1,1,$2,$3,$4,'0.0.1-bench')`,
          [`${type}:${destination}`,ORG,type,destination]);
      }
    }
    for (let round=0;round<PLAN.repetitions;round++) {
      const fact = await insertEvent(client);
      const command = await insertEvent(client,'message.send_requested');
      const outbox = await client.query('select event_id from outbox where event_id=any($1::uuid[])',[[fact.id,command.id]]);
      check(report,round===0?'done_capture':`done_capture_${round}`,'Fato done e comando pending capturados',
        fact.status==='done' && command.status==='pending' && outbox.rowCount===2,
        { factStatus: fact.status, commandStatus: command.status, outbox: outbox.rowCount });
      await client.query('begin');
      const ghost = await insertEvent(client);
      await fanoutInsideTransaction(client,ghost.id);
      await client.query('rollback');
      const ghosts = await observer.query(`select (select count(*) from event_log where id=$1)::int as events,
        (select count(*) from outbox where event_id=$1)::int as outbox,
        (select count(*) from receipts where event_id=$1)::int as receipts`,[ghost.id]);
      check(report,`rollback_${round}`,'Rollback não deixa evento ou entrega fantasma',
        Object.values(ghosts.rows[0]).every(value=>value===0),ghosts.rows[0]);

      await client.query('begin');
      const early = await insertEvent(client);
      await delay(5);
      await other.query('begin');
      const late = await insertEvent(other);
      await other.query('commit');
      const before = await observer.query('select event_id from outbox where event_id=any($1::uuid[])',[[early.id,late.id]]);
      await client.query('commit');
      const after = await observer.query('select event_id from outbox where event_id=any($1::uuid[])',[[early.id,late.id]]);
      check(report,round===0?'commit_order':`commit_order_${round}`,'Commit fora da ordem de criação conserva ambos os fatos',
        early.created_at<late.created_at && before.rowCount===1 && before.rows[0].event_id===late.id && after.rowCount===2,
        { createdFirst: early.created_at, createdSecond: late.created_at, visibleBeforeFirstCommit: before.rowCount,
          visibleAfterBothCommits: after.rowCount });

      await Promise.all([fanout(client,fact.id),fanout(other,fact.id)]);
      const receipts = await client.query('select * from receipts where event_id=$1',[fact.id]);
      const contenders = await Promise.all([claim(client,fact.id,'local-a',5000),claim(other,fact.id,'local-a',5000)]);
      const claimed = contenders.filter(Boolean);
      const distinct = await claim(other,fact.id,'local-b',5000);
      const finished = claimed.length===1 && await finishLocal(client,claimed[0]);
      const finishedOther = distinct && await finishLocal(other,distinct);
      const duplicate = claimed.length===1 && await finishLocal(client,claimed[0]);
      const effects = await client.query(`select count(*)::int as n from local_effects l join receipts r on r.id=l.receipt_id where r.event_id=$1`,[fact.id]);
      check(report,`concurrency_fanout_duplicate_${round}`,'Fan-out repetido e dois consumidores preservam recibo e efeito único por destino',
        receipts.rowCount===3 && receipts.rows.every(r=>r.version==='0.0.1-bench') && claimed.length===1
        && finished && finishedOther && !duplicate && effects.rows[0].n===2,
        { receipts:receipts.rowCount, simultaneousClaims:claimed.length, localEffects:effects.rows[0].n, duplicateAccepted:duplicate });

      const crashEvent = await insertEvent(client); await fanout(client,crashEvent.id);
      const crashed = startChild(context,schema,crashEvent.id,'crash');
      const old = await crashed.message;
      crashed.child.kill('SIGKILL');
      const exit = await crashed.exit;
      await delay(PLAN.localLeaseMs+50);
      const resumed = startChild(context,schema,crashEvent.id,'resume');
      const reclaimed = await resumed.message;
      const staleAccepted = await finishLocal(client,old.receipt);
      const beforeFinish = (await client.query('select state from receipts where id=$1',[old.receipt.id])).rows[0].state;
      const finishedMessage = once(resumed.child,'message');
      resumed.child.send({ action:'finish' });
      const [resumedResult] = await finishedMessage;
      await resumed.exit;
      const recovered = (await client.query('select * from receipts where id=$1',[old.receipt.id])).rows[0];
      check(report,`lease_restart_${round}`,'Processo morto recupera lease e rejeita dono antigo',
        exit[1]==='SIGKILL' && reclaimed.phase==='reclaimed' && beforeFinish==='processing'
        && resumedResult.finished && recovered.state==='done' && recovered.attempts===2 && !staleAccepted,
        { signal:exit[1], stateWhenOldTokenRefused:beforeFinish, state:recovered.state, attempts:recovered.attempts, staleAccepted });

      const core = await client.query('select status,consumed_by,attempts from event_log where id=any($1::uuid[])',[[fact.id,command.id,crashEvent.id]]);
      check(report,`core_untouched_${round}`,'Entregas preservam status, tentativas e consumidores do núcleo',
        core.rows.every(r=>r.attempts===0 && r.consumed_by.length===0)
        && core.rows.filter(r=>r.status==='done').length===2 && core.rows.filter(r=>r.status==='pending').length===1,core.rows);
    }

    const foreign = await insertEvent(client,'contact.updated',ORG_OTHER);
    const foreignOutbox = await client.query('select * from outbox where event_id=$1',[foreign.id]);
    check(report,'subscription_scope','Assinatura de A não captura evento de B',foreignOutbox.rowCount===0,
      { deliveriesForOtherOrganization:foreignOutbox.rowCount });
    await exerciseHttp(report,client,other,receiverDb);
    report.measurements.insert = await measureInserts(client);
    check(report,'insert_measurement','INSERT comparado com e sem captura no mesmo banco',
      report.measurements.insert.withCapture.n===500 && report.measurements.insert.withoutCapture.n===500,
      { withoutCapture:report.measurements.insert.withoutCapture,withCapture:report.measurements.insert.withCapture });
    await exerciseLock(report,client,other,observer);
    report.status = report.checks.every(c=>c.passed)?'passed':'failed';
  } catch (error) {
    check(report,'unexpected_error','Execução sem exceção inesperada',false,{ name:error.name, code:error.code ?? null,
      message: databaseUrl ? String(error.message).replaceAll(databaseUrl,'[banco da bancada]') : error.message });
    report.status = 'failed';
  } finally {
    // Conservar o schema dá evidência auditável; nunca tocar public ou schema alheio.
    for (const client of clients) {
      try { await client.query('rollback'); } catch { /* conexão perdida */ }
      await client.end();
    }
    report.completedAt = new Date().toISOString();
    if (evidenceDir) {
      await mkdir(evidenceDir,{recursive:true});
      await writeJsonAtomic(join(evidenceDir,'events-report.json'),report);
    }
  }
  return report;
}

async function fanoutInsideTransaction(client,eventId) {
  await client.query(`insert into receipts(event_id,organization_id,subscription_id,subscription_revision,destination,version)
    select e.id,e.organization_id,s.id,s.revision,s.destination,s.version from event_log e
    join subscriptions s on s.organization_id=e.organization_id and s.event_type=e.event_type where e.id=$1`,[eventId]);
}

async function exerciseHttp(report,client,other,receiverDb) {
  let slowArrived;
  let releaseSlow;
  let receiverError;
  let requests = 0;
  const server = createServer(async (req,res) => {
    req.resume();
    try {
      if (req.url==='/slow') {
        slowArrived();
        await new Promise(resolve=>{releaseSlow=resolve;});
        res.end('confirmed');
      } else if (req.url==='/lost') {
        requests++;
        await receiverDb.query(`insert into external_effects(receipt_id) values($1)
          on conflict(receipt_id) do update set requests=external_effects.requests+1`,[req.headers['x-receipt-id']]);
        req.socket.destroy();
      } else { res.writeHead(404); res.end(); }
    } catch (error) { receiverError=error; req.socket.destroy(); }
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const port=server.address().port;
  try {
    for (let round=0;round<PLAN.repetitions;round++) {
      const event=await insertEvent(client); await fanout(client,event.id);
      const receipt=await claim(client,event.id,'external',5000); await markSending(client,receipt);
      const arrived=new Promise(resolve=>{slowArrived=resolve;});
      const sent=post(port,'/slow',receipt.id);
      // Anexar rejeição imediatamente impede unhandled rejection se o teste falhar antes do await.
      const outcome=sent.then(status=>({status}),error=>({error}));
      await Promise.race([arrived,outcome.then(result=>{
        if(result.error) throw result.error;
        throw new Error('Receiver respondeu sem observar a barreira experimental.');
      })]);
      const started=performance.now();
      const independent=await insertEvent(other);
      const fast=await claim(other,event.id,'local-a',5000);
      const fastFinished=await finishLocal(other,fast);
      const localMs=performance.now()-started;
      const sending=(await client.query('select state from receipts where id=$1',[receipt.id])).rows[0].state;
      releaseSlow();
      const response=await outcome;
      if(response.error) throw response.error;
      await client.query(`update receipts set state='done' where id=$1 and state='sending' and lease_token=$2`,[receipt.id,receipt.lease_token]);
      check(report,`slow_receiver_${round}`,'Receiver lento não ocupa a transação original ou outro destino',
        sending==='sending' && independent.status==='done' && fastFinished && response.status===200,
        { fastPathMs:localMs, slowStateWhileOtherWorkFinished:sending, receiverStatus:response.status });

      const uncertain=await insertEvent(client); await fanout(client,uncertain.id);
      const outgoing=await claim(client,uncertain.id,'external',PLAN.localLeaseMs);
      await markSending(client,outgoing);
      let failed=false;
      try { await post(port,'/lost',outgoing.id); } catch { failed=true; }
      if(receiverError) throw receiverError;
      if(failed) await client.query(`update receipts set state='uncertain' where id=$1 and state='sending'`,[outgoing.id]);
      await delay(PLAN.localLeaseMs+30);
      const retry=await claim(other,uncertain.id,'external');
      const state=(await client.query('select state,attempts from receipts where id=$1',[outgoing.id])).rows[0];
      const effect=(await receiverDb.query('select requests from external_effects where receipt_id=$1',[outgoing.id])).rows[0];
      // Só o oráculo de teste lê external_effects; o worker NÃO infere sucesso desta leitura.
      check(report,round===0?'uncertain_effect':`uncertain_effect_${round}`,'Efeito consumado sem resposta exige reconciliação e não repete POST',
        failed && state.state==='uncertain' && state.attempts===1 && retry===null && effect?.requests===1,
        { state:state.state, attempts:state.attempts, automaticClaim:retry, externalEffects:effect?.requests,
          nextAction:'Reconciliar com receiver por identidade ou encaminhar tarefa humana; não repetir automaticamente.' });
    }
    report.measurements.http={ receiver:'HTTP real em 127.0.0.1 com porta efêmera',lostResponseRequests:requests };
  } finally {
    releaseSlow?.(); server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
  }
}

async function exerciseLock(report,client,blocker,observer) {
  for(let round=0;round<PLAN.repetitions;round++) {
    await blocker.query('begin');
    await blocker.query('lock table outbox in access exclusive mode');
    const pid=(await client.query('select pg_backend_pid() as pid')).rows[0].pid;
    const started=performance.now();
    let settled=false;
    const insert=insertEvent(client).then(value=>{settled=true;return {value};},error=>{settled=true;return {error};});
    let observed;
    try {
      do {
        observed=(await observer.query(`select wait_event_type,wait_event,pg_blocking_pids(pid) as blockers
          from pg_stat_activity where pid=$1`,[pid])).rows[0];
        if(observed.wait_event_type==='Lock') break;
        await delay(10);
      } while(performance.now()-started<PLAN.lockObservationTimeoutMs);
      const blocked=!settled && observed.wait_event_type==='Lock' && observed.blockers.length>0;
      await delay(100);
      await blocker.query('commit');
      const finished=await insert;
      if(finished.error) throw finished.error;
      check(report,`outbox_blocks_origin_${round}`,'Lock real da caixa de saída bloqueia o INSERT de origem',
        blocked && finished.value.status==='done', { observed,insertElapsedMs:performance.now()-started,
          consequence:'A captura é transacional: contenção da caixa afeta o tempo de gravação da origem.' });
    } finally { await blocker.query('rollback'); }
  }
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const report=await runProbe(await readContext(process.cwd()));
  process.stdout.write(JSON.stringify(report,null,2)+'\n');
  process.exitCode=report.status==='passed'?0:1;
}
