import assert from 'node:assert/strict';
import { readFile, writeFile, rm, access } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
import { childEnvironment, connectBenchDatabase } from '../common.mjs';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const roles = ['bench_state_tenant_a', 'bench_state_tenant_b'];

/** Instrumento local; não usa .env, Supabase, nem qualquer credencial do CRM. */
export async function runProbe({ databaseUrl, repoRoot, evidenceDir }) {
  const started = performance.now();
  const report = {
    id: 'state', status: 'blocked',
    environment: { platform: `${process.platform}-${process.arch}`, node: process.version },
    checks: [], measurements: {},
    limitations: [
      'Fixture SQL em PostgreSQL nativo dedicado; não é migration publicável nem prova no piso pg15/Supabase/baseline do CRM.',
      'Conexões SQL não-donas medem grants/RLS; PostgREST, JWT/RBAC do CRM e experiência em tela não estão integrados.',
      'Guarda cobre efeitos no mesmo banco. Um envio externo exige outbox e reconciliação; não há atomicidade DB+rede neste ensaio.',
      'Remoção real de fixture executável é medida; atualização real do CRM, catálogo desligado e armazenamento privado externo não são medidos.',
      'Nomes e payloads são sintéticos; a declaração de campos pessoais é revisada manualmente e não descobre cópias desconhecidas.',
      'Papéis de conexão por tenant são instrumentos de teste, não proposta de autenticação para produção.',
      'Privacidade mede entrega positiva e replay sequencial após erase; não mede disputa simultânea entre entrega e anonimização.',
    ],
  };
  const clients = new Set();
  let admin;
  let locked = false;
  let currentCheck = 'setup';
  const check = (id, name, observed) => report.checks.push({ id, name, passed: true, observed });
  const connect = async (role) => {
    const client = await connectBenchDatabase({ databaseUrl, repoRoot, evidenceDir }, role ? { user: role } : {});
    clients.add(client);
    await client.query("set statement_timeout='5s'");
    await client.query("set idle_in_transaction_session_timeout='15s'");
    return client;
  };
  const reject = async (client, sql, params, code, message) => {
    try { await client.query(sql, params); } catch (error) {
      assert.equal(error.code, code);
      if (message) assert.equal(error.message, message);
      return { code: error.code, message: error.message };
    }
    assert.fail('A operação que deveria ser recusada foi admitida');
  };
  // Sincroniza pela espera real no lock, sem depender de um sleep para acertar a corrida.
  const waitForLock = async (pid) => {
    const deadline = performance.now() + 2500;
    while (performance.now() < deadline) {
      const { rows } = await admin.query('select wait_event_type,wait_event from pg_stat_activity where pid=$1', [pid]);
      if (rows[0]?.wait_event_type === 'Lock') return rows[0];
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('A segunda conexão não esperou o lock esperado');
  };
  try {
    if (!databaseUrl) {
      report.limitations.push('Banco exclusivo ausente: forneça databaseUrl local explicitamente.');
      return report;
    }
    const url = new URL(databaseUrl);
    if (!['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.search) {
      throw new Error('A bancada exige DSN loopback sem opções que redirecionem o host');
    }
    assert.ok(repoRoot && evidenceDir, 'repoRoot e evidenceDir são obrigatórios');
    admin = await connect();
    const meta = (await admin.query('select version() as version,current_database() as database,host(inet_server_addr()) as address')).rows[0];
    assert.ok(['127.0.0.1', '::1'].includes(meta.address), 'Servidor deve estar em loopback');
    report.environment.postgres = meta.version;
    report.environment.database = meta.database;
    await admin.query('select pg_advisory_lock(19004,4)');
    locked = true;
    report.status = 'failed';
    for (const role of roles) {
      const existing = (await admin.query('select rolsuper,rolbypassrls,rolcreaterole,rolcreatedb from pg_roles where rolname=$1', [role])).rows[0];
      if (!existing) await admin.query(`create role ${role} login nosuperuser nobypassrls nocreatedb nocreaterole noinherit`);
      else assert.ok(Object.values(existing).every(value => value === false), 'Papel existente tem privilégios inesperados');
    }
    await admin.query('drop schema if exists bench_state cascade');
    const fixtureDir = path.join(repoRoot, 'experiments/extensoes/state');
    await admin.query(await readFile(path.join(fixtureDir, 'fixture.sql'), 'utf8'));
    await admin.query("insert into bench_state.subjects values ($1,'subject','Pessoa Sintetica A',1,false),($2,'subject','Pessoa Sintetica B',1,false)", [A, B]);
    const a = await connect(roles[0]);
    const b = await connect(roles[1]);

    currentCheck = 'non_owner_rls';
    const authority = (await a.query("select current_user,session_user,r.rolsuper,r.rolbypassrls,(c.relowner=r.oid) as owns_table from pg_roles r cross join pg_class c join pg_namespace n on n.oid=c.relnamespace where r.rolname=current_user and n.nspname='bench_state' and c.relname='records'")).rows[0];
    assert.equal(authority.rolsuper, false);
    assert.equal(authority.rolbypassrls, false);
    assert.equal(authority.owns_table, false);
    assert.equal((await a.query('select * from bench_state.subjects')).rows.length, 1);
    assert.equal((await b.query('select organization_id from bench_state.subjects')).rows[0].organization_id, B);
    assert.equal((await a.query('select * from bench_state.subjects where organization_id=$1', [B])).rowCount, 0);
    await reject(a, 'insert into bench_state.rls_canary values ($1,$2)', [B, 'cross-tenant'], '42501');
    assert.equal((await a.query("update bench_state.rls_canary set id='stolen' where organization_id=$1", [B])).rowCount, 0);
    await reject(a, 'update bench_state.activation set active=false', [], '42501');
    await reject(a, 'update bench_state.activation set can_write=true', [], '42501');
    await reject(a, "insert into bench_state.effects values ($1,'direct',1,now())", [A], '42501');
    await a.query("set app.organization_id='00000000-0000-4000-8000-00000000000b'");
    assert.equal((await a.query('select bench_state.tenant_id() as org')).rows[0].org, A);
    check('non_owner_rls', 'Isolamento e autoridade direta', { ...authority, crossTenantRows: 0, rlsInsertDenied: true, activationAndGrantWritesDenied: true, forgedContextIgnored: true });

    currentCheck = 'old_job_schema';
    await a.query("select bench_state.write_record(1,'v1-before','subject',100,'nota antiga')");
    await a.query("select bench_state.admit_job('old-job','subject',1,$1)", [{ kind: 'record', record_id: 'drained-old-job', amount_cents: 250, note: 'drenado com v1' }]);
    await admin.query(await readFile(path.join(fixtureDir, 'additive.sql'), 'utf8'));
    await a.query("select bench_state.write_record(1,'v1-after','subject',200,'nota v1')");
    await a.query("select bench_state.write_record(2,'v2-after','subject',300,'nota v2','rotulo')");
    await reject(a, "select bench_state.write_record(2,'negative','subject',-1,null,null)", [], '23514');
    const oldRows = (await a.query('select id,amount_cents,legacy_note from bench_state.records order by id')).rows;
    const newRows = (await a.query('select id,amount_cents,legacy_note,label from bench_state.records order by id')).rows;
    assert.equal(oldRows.length, 3);
    assert.equal(newRows.find(row => row.id === 'v2-after').label, 'rotulo');
    assert.equal(newRows.find(row => row.id === 'v1-after').label, null);
    const incompatible = await readFile(path.join(fixtureDir, 'incompatible.sql'), 'utf8');
    await reject(admin, incompatible, [], 'P0001', 'old_jobs_require_drain_or_cancel');
    await admin.query("update bench_state.jobs set status='suspended',next_step='host: drain with pinned v1 or explicitly cancel before schema change' where id='old-job'");
    await reject(admin, incompatible, [], 'P0001', 'old_jobs_require_drain_or_cancel');
    const nextStep = (await a.query("select next_step from bench_state.jobs where id='old-job'")).rows[0].next_step;
    await admin.query("update bench_state.jobs set status='pending',next_step='host: draining pinned v1' where id='old-job'");
    const persistedJob = (await a.query("select contract_version,payload,status from bench_state.jobs where id='old-job'")).rows[0];
    assert.equal(persistedJob.contract_version, 1);
    assert.equal(persistedJob.status, 'pending');
    assert.equal((await a.query('select * from bench_state.records where id=$1', [persistedJob.payload.record_id])).rowCount, 0);
    await a.query("select bench_state.deliver_job('old-job',$1)", [persistedJob.payload]);
    const drainedJob = (await a.query("select status,next_step from bench_state.jobs where id='old-job'")).rows[0];
    const drainedRecord = (await a.query('select amount_cents,legacy_note from bench_state.records where id=$1', [persistedJob.payload.record_id])).rows[0];
    assert.deepEqual(drainedJob, { status: 'done', next_step: 'none' });
    assert.equal(drainedRecord.amount_cents, String(persistedJob.payload.amount_cents));
    assert.equal(drainedRecord.legacy_note, persistedJob.payload.note);
    await admin.query(incompatible);
    const retainedAmount = (await a.query('select amount_minor from bench_state.records where id=$1', [persistedJob.payload.record_id])).rows[0].amount_minor;
    assert.equal(retainedAmount, String(persistedJob.payload.amount_cents));
    await reject(a, "select bench_state.write_record(1,'too-late','subject',1,null)", [], 'P0001', 'contract_incompatible');
    await reject(a, "select bench_state.admit_job('too-late','subject',1,'{}')", [], 'P0001', 'contract_incompatible');
    const currentPayload = { kind: 'record', record_id: 'v3-delivery', amount_minor: 400, note: 'contrato v3', label: 'v3' };
    await a.query("select bench_state.admit_job('current-job','subject',3,$1)", [currentPayload]);
    await a.query("select bench_state.deliver_job('current-job',$1)", [currentPayload]);
    assert.equal((await a.query('select amount_minor from bench_state.records where id=$1', [currentPayload.record_id])).rows[0].amount_minor, String(currentPayload.amount_minor));
    assert.equal((await a.query("select status from bench_state.jobs where id='current-job'")).rows[0].status, 'done');
    check('old_job_schema', 'Contratos antigos, evolução aditiva e drenagem', { oldReadRows: oldRows.length, newReadRows: newRows.length, additiveWrites: [1, 2], incompatibleDeniedPending: true, incompatibleDeniedSuspended: true, nextStep, deliveryPath: 'deliver_job', consumedContractVersion: persistedJob.contract_version, deliveredJobStatus: drainedJob.status, effectMatchesStoredPayload: true, drainedAmountMinor: Number(retainedAmount), lateOldAdmissionDenied: true });

    currentCheck = 'deactivation_race';
    // Controle negativo: checar em uma transação e escrever depois permite TOCTOU.
    const observedActive = (await a.query('select active from bench_state.activation')).rows[0].active;
    await admin.query('update bench_state.activation set active=false,revision=revision+1 where organization_id=$1', [A]);
    if (observedActive) await admin.query("insert into bench_state.effects values ($1,'unsafe-stale-check',1,clock_timestamp())", [A]);
    assert.equal((await a.query("select * from bench_state.effects where id='unsafe-stale-check'")).rowCount, 1);
    // A ordem é controlada por locks observáveis em conexões reais.
    await admin.query('update bench_state.activation set active=true,revision=revision+1 where organization_id=$1', [A]);
    const disabler = await connect();
    await disabler.query('begin');
    await disabler.query('update bench_state.activation set active=false,revision=revision+1 where organization_id=$1', [A]);
    const deniedEffect = a.query("select bench_state.apply_effect('blocked-after-disable')").then(() => ({ success: true }), error => ({ code: error.code, message: error.message }));
    const firstWait = await waitForLock(a.processID);
    await disabler.query('commit');
    assert.deepEqual(await deniedEffect, { code: 'P0001', message: 'extension_inactive_or_grant_missing' });
    assert.equal((await a.query("select * from bench_state.effects where id='blocked-after-disable'")).rowCount, 0);
    await admin.query('update bench_state.activation set active=true,revision=revision+1 where organization_id=$1', [A]);
    await a.query('begin');
    await a.query("select bench_state.apply_effect('committed-before-disable')");
    const disableLater = disabler.query('update bench_state.activation set active=false,revision=revision+1 where organization_id=$1', [A]).then(() => ({ success: true }), error => ({ error: error.message }));
    const secondWait = await waitForLock(disabler.processID);
    await a.query('commit');
    assert.deepEqual(await disableLater, { success: true });
    assert.equal((await a.query("select * from bench_state.effects where id='committed-before-disable'")).rowCount, 1);
    await b.query("select bench_state.apply_effect('b-unaffected')");
    await admin.query('update bench_state.activation set active=true,can_write=false,revision=revision+1 where organization_id=$1', [A]);
    await reject(a, "select bench_state.apply_effect('grant-revoked')", [], 'P0001', 'extension_inactive_or_grant_missing');
    check('deactivation_race', 'Corrida sem guarda e serialização no efeito', { unsafeControlWroteAfterDisable: true, guardedRowsAfterDisable: 0, committedEarlierPreserved: 1, otherOrganizationUnaffected: true, grantRevocationDenied: true, waits: [firstWait, secondWait] });

    currentCheck = 'privacy_after_removal';
    const executableDir = await import('node:fs/promises').then(fs => fs.mkdtemp(path.join(evidenceDir, 'state-executable-')));
    const executable = path.join(executableDir, 'extension.mjs');
    await writeFile(executable, 'process.stdout.write("fixture-executed");\n', { mode: 0o700 });
    assert.equal((await promisify(execFile)(process.execPath, [executable], { env: childEnvironment() })).stdout, 'fixture-executed');
    const pii = 'COPIA_PESSOAL_SINTETICA_019';
    const oldPayload = { kind: 'subject_name', name: pii, nested: { name: pii } };
    await admin.query('update bench_state.activation set active=true,can_write=true,revision=revision+1 where organization_id=$1', [A]);
    assert.notEqual((await a.query("select display_name from bench_state.subjects where id='subject'")).rows[0].display_name, pii);
    await a.query("select bench_state.admit_job('privacy-positive','subject',3,$1)", [oldPayload]);
    await a.query("select bench_state.deliver_job('privacy-positive',$1)", [oldPayload]);
    assert.equal((await a.query("select display_name from bench_state.subjects where id='subject'")).rows[0].display_name, pii);
    assert.deepEqual((await a.query("select status,next_step from bench_state.jobs where id='privacy-positive'")).rows[0], { status: 'done', next_step: 'none' });
    await admin.query('update bench_state.records set legacy_note=$1,label=$1 where organization_id=$2', [pii, A]);
    await a.query("select bench_state.admit_job('privacy-job','subject',3,$1)", [oldPayload]);
    for (const kind of ['outbox', 'receipt', 'invocation', 'result']) {
      await admin.query("insert into bench_state.copies values($1,$2,'subject',$2,$3)", [A, kind, oldPayload]);
    }
    await admin.query('update bench_state.activation set active=false where organization_id=$1', [A]);
    await rm(executable);
    await assert.rejects(access(executable), { code: 'ENOENT' });
    const hostAfterRemoval = await connect(roles[0]);
    const exported = (await hostAfterRemoval.query("select bench_state.export_subject('subject') as data")).rows[0].data;
    assert.ok(JSON.stringify(exported).includes(pii));
    assert.equal(exported.copies.length, 4);
    const beforeB = (await b.query("select bench_state.export_subject('subject') as data")).rows[0].data;
    const timestampBefore = (await a.query("select created_at from bench_state.effects where id='committed-before-disable'")).rows[0].created_at;
    await hostAfterRemoval.query("select bench_state.erase_subject('subject')");
    await hostAfterRemoval.query("select bench_state.erase_subject('subject')");
    await reject(hostAfterRemoval, "select bench_state.deliver_job('privacy-job',$1)", [oldPayload], 'P0001', 'privacy_revision_stale');
    const redacted = (await hostAfterRemoval.query("select bench_state.export_subject('subject') as data")).rows[0].data;
    assert.equal(JSON.stringify(redacted).includes(pii), false);
    assert.equal(redacted.subject.erased, true);
    assert.equal(redacted.subject.privacy_revision, 2);
    assert.equal(redacted.jobs.find(job => job.id === 'privacy-job').status, 'cancelled');
    assert.deepEqual((await b.query("select bench_state.export_subject('subject') as data")).rows[0].data, beforeB);
    assert.deepEqual((await a.query("select created_at from bench_state.effects where id='committed-before-disable'")).rows[0].created_at, timestampBefore);
    const inventory = (await admin.query('select * from bench_state.inventory order by relation_name')).rows;
    await writeFile(path.join(evidenceDir, 'state-redacted-export.json'), JSON.stringify({ inventory, redacted }, null, 2));
    check('privacy_after_removal', 'Histórico, exportação e anonimização sem executável', { executableRemoved: true, hostReconnected: true, positiveDeliveryPath: 'deliver_job', positiveDeliveryChangedSubject: true, positiveJobStatus: 'done', exportedCopyKinds: exported.copies.map(copy => copy.kind), inventory, erasedRevision: redacted.subject.privacy_revision, staleReplayDenied: true, replayOrdering: 'sequential_after_erase', organizationBPreserved: true, historicalTimestampPreserved: true });

    currentCheck = 'resumable_operation';
    await admin.query('update bench_state.activation set active=true,can_write=true,revision=revision+1 where organization_id=$1', [A]);
    await admin.query("insert into bench_state.operations values($1,'resumable','prepared',1,'apply_effect_once')", [A]);
    const interrupted = await connect(roles[0]);
    assert.equal((await interrupted.query("select bench_state.resume_operation('resumable') as stage")).rows[0].stage, 'effect_committed');
    await interrupted.end();
    clients.delete(interrupted);
    const resumed = await connect(roles[0]);
    assert.equal((await resumed.query("select stage from bench_state.operations where id='resumable'")).rows[0].stage, 'effect_committed');
    await resumed.query("select bench_state.resume_operation('resumable')");
    await resumed.query("select bench_state.resume_operation('resumable')");
    const operation = (await resumed.query("select * from bench_state.operations where id='resumable'")).rows[0];
    const effects = (await resumed.query("select * from bench_state.effects where id='resumable'")).rowCount;
    assert.equal(operation.stage, 'complete');
    assert.equal(operation.next_step, 'none');
    assert.equal(effects, 1);
    assert.equal((await admin.query('select schema_version from bench_state.installation')).rows[0].schema_version, 3);
    check('resumable_operation', 'Retomada após interrupção entre etapas duráveis', { stage: operation.stage, nextStep: operation.next_step, attempts: operation.attempts, effectCount: effects, schemaRemains: 3, interruption: 'connection closed after effect commit before finalization' });
    report.status = 'passed';
  } catch (error) {
    report.checks.push({ id: currentCheck, name: 'Falha observada na bancada de estado', passed: false, observed: { code: error.code ?? error.name, message: error.message } });
    // Ausência de infraestrutura bloqueia; regressão depois do setup reprova.
    if (!locked) report.status = 'blocked';
    else report.status = 'failed';
  } finally {
    for (const client of clients) {
      try { await client.query('rollback'); } catch { /* Conexão encerrada; end faz o restante. */ }
    }
    if (locked && admin) await admin.query('select pg_advisory_unlock(19004,4)').catch(() => {});
    await Promise.allSettled([...clients].map(client => client.end()));
    report.measurements.elapsedMs = Math.round(performance.now() - started);
  }
  return report;
}
