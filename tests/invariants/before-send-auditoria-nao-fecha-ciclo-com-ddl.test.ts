/**
 * #2426 — com um DDL na fila de `contacts`, a auditoria do `runBeforeSend` não pode
 * fechar ciclo com a transação do envio. Postgres REAL, três conexões:
 *
 *   tx do envio (pool.connect) — lê `contacts` sob o lock do número (ACCESS SHARE);
 *   DDL (cliente à parte)      — pede ACCESS EXCLUSIVE em `contacts` e entra na fila;
 *   auditoria (pool.query)     — `insert into before_send_traces`, FK para `contacts`.
 *
 * Se a auditoria sai ENQUANTO a tx está aberta, o insert espera o DDL, o DDL espera a tx e
 * a tx espera o insert — ciclo que o Postgres não detecta (uma aresta mora no Node). Em
 * produção não há `lock_timeout` e o worker pendura (#2363: 8m47s). Aqui o pool tem
 * `lock_timeout` curto para o teste terminar: com o defeito, o insert estoura, o
 * `persistTrace` engole o erro e a linha de auditoria NÃO existe.
 *
 * O #2827 tira da janela só a AUDITORIA (trace, timeline do veto, escalação de LGPD). O
 * `args.send` de produção (`sendWithLedger` → `send_ledger` e `messages`, as duas com FK
 * para `contacts`) ainda grava por OUTRA conexão com a tx aberta. O último caso imita isso
 * e está em `it.fails`: é a metade que o #2426 segue pedindo (advisory lock de SESSÃO).
 * Quando ela fechar, o `it.fails` reprova — troque por `it` e apague esta nota.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, expect, it, vi } from 'vitest';

import { runBeforeSend, type Gate } from '@/lib/agent-engine/guardrails/before-send';

const URL = `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`;
const pool = new pg.Pool({ connectionString: URL, max: 4, options: '-c lock_timeout=3000' });
afterAll(() => pool.end());

async function fixture() {
  const org = randomUUID(), contact = randomUUID(), session = randomUUID(), job = randomUUID();
  await pool.query("insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Ciclo DDL','Ciclo DDL')", [org]);
  await pool.query("insert into contacts(id,organization_id,name,phone_number) values($1,$2,'Lead Ciclo','+5511900002426')", [contact, org]);
  await pool.query("insert into channel_sessions(id,organization_id,waha_session_name,status,webhook_secret_encrypted) values($1::uuid,$2,$1::text,'WORKING','\\x00'::bytea)", [session, org]);
  await pool.query("insert into job_queue(id,organization_id,contact_id,kind) values($1,$2,$3,'inbound_turn')", [job, org, contact]);
  return { org, contact, session, job };
}

const vetaSempre: Gate = { name: 'gate_de_teste', evaluate: () => ({ pass: false, code: 'teste_veto', reason: 'veto de teste' }) };

type Fixture = Awaited<ReturnType<typeof fixture>>;
const sendStub = async () => ({ kind: 'sent' as const, idempotencyKey: 'k', messageId: 'm' });
// Como o `sendWithLedger` de produção: grava a intenção em `send_ledger` (FK `contacts`)
// pelo POOL, não pelo cliente da tx — outra conexão, com a tx do número ainda aberta.
const sendQueGravaOLedger = (f: Fixture) => async () => {
  await pool.query(
    "insert into send_ledger(organization_id,contact_id,job_id,seq,body_hash) values($1,$2,$3,0,'h')",
    [f.org, f.contact, f.job],
  );
  return sendStub();
};

it.each([
  ['enviado', [] as Gate[], 'sent'],
  ['vetado', [vetaSempre], 'vetoed'],
] as const)('caminho %s: DDL na fila de contacts não derruba a auditoria', async (_n, gates, esperado) => {
  const f = await fixture();
  await rodarComDdlNaFila(f, [...gates], sendStub, esperado);
});

// Controle positivo da catraca abaixo, `it` normal de propósito: `it.fails` é satisfeito por
// QUALQUER falha (fixture, FK, import). Sem DDL na fila, o mesmo envio que grava o ledger
// pelo pool TEM de completar — então o vermelho de baixo é o ciclo, não a montagem.
it('controle positivo: sem DDL na fila, o envio que grava send_ledger pelo pool completa', async () => {
  const f = await fixture();
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const r = await runBeforeSend({
    pool, log, tenantId: f.org, leadId: f.contact, jobId: f.job, channelSessionId: f.session,
    body: 'Olá! Segue o orçamento que você pediu.', optedOutThisTurn: false, crmDailyLimit: null,
    now: new Date(), rng: () => 0, sleep: async () => {}, gates: [], send: sendQueGravaOLedger(f),
  });
  expect(r.status).toBe('sent');
  const n = (await pool.query('select count(*)::int n from send_ledger where job_id=$1', [f.job])).rows[0].n;
  expect(n).toBe(1);
});

// #2426, a metade ABERTA: com o envio gravando o ledger pelo pool, o insert espera o DDL,
// o DDL espera a tx e a tx espera o envio. Aqui o `lock_timeout` do pool estoura (55P03) e
// o `runBeforeSend` lança; em produção, sem `lock_timeout`, o worker pendura.
it.fails('caminho enviado com o envio gravando send_ledger pelo pool: metade aberta do #2426', async () => {
  const f = await fixture();
  await rodarComDdlNaFila(f, [], sendQueGravaOLedger(f), 'sent');
});

async function rodarComDdlNaFila(
  f: Fixture,
  gates: Gate[],
  send: () => Promise<{ kind: 'sent'; idempotencyKey: string; messageId: string }>,
  esperado: 'sent' | 'vetoed',
) {
  const ddl = new pg.Client({ connectionString: URL });
  await ddl.connect();
  const observador = await pool.connect();
  let ddlPendente: Promise<unknown> | undefined;
  const connectReal = pool.connect.bind(pool);
  // Espião: o pool devolve o cliente REAL da tx; logo depois da leitura de `contacts`
  // (readStopFlags), um DDL entra na fila — e só seguimos quando ele está ESPERANDO a tx.
  // O casamento tolera o `cross join lateral` da etiqueta de contato interno (#2353) entre
  // `from contacts` e o `where`: casar só o texto colado deixava a sonda sem armar.
  const poolComDdl = Object.create(pool) as pg.Pool;
  // O pg-pool chama `this.connect(cb)` dentro do `pool.query`: com callback, delega intacto.
  poolComDdl.connect = ((cb?: unknown) => cb ? (connectReal as (x: unknown) => void)(cb) : (async () => {
    const c = await connectReal();
    const queryReal = c.query.bind(c) as (...a: unknown[]) => Promise<unknown>;
    const pid = ((await c.query('select pg_backend_pid() pid')).rows[0] as { pid: number }).pid;
    (c as { query: unknown }).query = async (...a: unknown[]) => {
      const r = await queryReal(...a);
      if (!ddlPendente && typeof a[0] === 'string' && /from contacts\b[\s\S]*\bwhere organization_id/.test(a[0])) {
        ddlPendente = ddl.query("set statement_timeout='20s'; begin; lock table contacts in access exclusive mode; commit");
        await expect.poll(async () => {
          const row = (await observador.query("select wait_event_type, pg_blocking_pids(pid) b from pg_stat_activity where query like '%lock table contacts%' and pid <> pg_backend_pid()")).rows[0];
          return row?.wait_event_type === 'Lock' && (row.b as number[]).includes(pid);
        }, { timeout: 5000, interval: 20 }).toBe(true);
      }
      return r;
    };
    return c;
  })()) as pg.Pool['connect'];

  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  try {
    const r = await runBeforeSend({
      pool: poolComDdl, log, tenantId: f.org, leadId: f.contact, jobId: f.job, channelSessionId: f.session,
      body: 'Olá! Segue o orçamento que você pediu.', optedOutThisTurn: false, crmDailyLimit: null,
      now: new Date(), rng: () => 0, sleep: async () => {}, gates,
      send,
    });
    expect(r.status).toBe(esperado);
    expect(ddlPendente, 'o DDL nunca entrou na fila — a sonda não armou').toBeDefined();
    await ddlPendente;
    expect(log.error.mock.calls.map((c) => c[0]), 'auditoria perdida atrás do DDL').toEqual([]);
    const n = (await pool.query('select count(*)::int n from before_send_traces where job_id=$1', [f.job])).rows[0].n;
    expect(n).toBe(1);
  } finally {
    await ddlPendente?.catch(() => undefined);
    await ddl.end();
    observador.release();
  }
}
