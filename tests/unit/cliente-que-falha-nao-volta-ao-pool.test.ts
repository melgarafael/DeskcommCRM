/**
 * #2506 — um cliente que falha DENTRO da transação não pode voltar ao pool sem erro.
 *
 * Com o #2501 `createPool` ganhou `query_timeout` de 60s. No caminho `pool.query`
 * a consulta que estoura devolve o cliente com `release(err)` e o pg-pool o
 * descarta (`_release` com erro → `_remove`, pg-pool 3.14.0). Nos call sites que
 * fazem `pool.connect()` e controlam a transação à mão, o `finally` chamava
 * `client.release()` SEM erro — e o pg 8.23, fora do modo pipeline, rejeita a
 * promessa do timeout sem destruir o socket. O cliente voltava ao pool com a
 * transação antiga de pé e era reemprestado nela pelo próximo dono.
 *
 * O que este arquivo mede, com cliente FALSO (`query` que rejeita + `release`
 * espio), nos 6 call sites dos 5 arquivos da issue:
 *   (a) consulta que rejeita dentro da transação → `release` chamado COM erro;
 *   (b) caminho feliz → `release` chamado SEM erro (nada muda para quem não falhou);
 *   (c) o erro continua subindo — o rollback não o engole.
 *
 * Nasce VERMELHO: sem o `release(erroNaTransacao)` dos 5 arquivos, (a) reprova em
 * todos os caminhos (é a sabotagem que prova o contra-experimento).
 *
 * O QUE NÃO É MEDIDO AQUI (declarado também no PR): o reuso real de socket contra
 * Postgres de produção. Não há Postgres desta máquina — o lado "cliente com erro
 * é descartado em vez de reemprestado" é a semântica do próprio pg-pool
 * (`release(err)` → `_remove`) e a medição da issue em VPS com Postgres 17.
 */
import type pg from 'pg';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as SuporteDeImpersonate from '@/lib/impersonate/support';

import { markAwaitingLead } from '@/lib/agent-engine/agent/human-cases';
import { seedPlatformPlaybook } from '@/lib/agent-engine/agent/playbook-seed';
import { tickCron, type CronTickConfig } from '@/lib/agent-engine/cron/scheduler';
import { getRequestPool } from '@/lib/agent-engine/db/request-pool';
import { runBeforeSend, type RunBeforeSendArgs } from '@/lib/agent-engine/guardrails/before-send';
import type { Logger } from '@/lib/agent-engine/obs/logger';
import { claimJobs, completeJob } from '@/lib/agent-engine/queue/queue';
import { requireRole, type RoleCheck } from '@/lib/auth/require-role';
import type { AuthUser } from '@/lib/auth/types';

vi.mock('@/lib/auth/require-role', () => ({ requireRole: vi.fn() }));
vi.mock('@/lib/agent-engine/db/request-pool', () => ({ getRequestPool: vi.fn() }));
vi.mock('@/lib/audit', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('@/lib/agent-engine/agent/human-cases', () => ({
  resolveCaseFromHuman: vi.fn(),
  markAwaitingLead: vi.fn(),
  escalateCase: vi.fn(),
}));
vi.mock('@/lib/agent-engine/agent/human-handoff', () => ({
  performHumanHandoff: vi.fn(async () => undefined),
}));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn(() => ({})) }));
// A autoridade de suporte é exercitada na suíte própria daquele módulo.
vi.mock('@/lib/impersonate/support', async (importOriginal) => ({
  ...(await importOriginal<typeof SuporteDeImpersonate>()),
  requireSupportWrite: vi.fn(async () => null),
  authenticatedSessionId: vi.fn(async () => 'f2200000-0000-4000-8000-000000000099'),
}));

const MENSAGEM = 'Query read timeout';

interface ClienteFalso {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
}

/**
 * Cliente fake: `query` rejeita em `falhaEm` (substring minúscula do SQL — a
 * consulta que "estoura o timeout"), devolve `linhas` para o resto e `rowCount: 1`
 * por default; `release` é espio, é por ele que se mede o desfecho.
 */
function clienteFalso(falhaEm?: string, linhas: Array<[string, unknown[]]> = []): ClienteFalso {
  return {
    query: vi.fn(async (sql: string) => {
      const s = String(sql).toLowerCase();
      if (falhaEm !== undefined && s.includes(falhaEm)) throw new Error(MENSAGEM);
      const achado = linhas.find(([sub]) => s.includes(sub));
      return { rows: achado?.[1] ?? [], rowCount: 1 };
    }),
    release: vi.fn(),
  };
}

function poolFalso(cliente: ClienteFalso, linhasDoPool: unknown[] = []): pg.Pool {
  return {
    connect: vi.fn(async () => cliente),
    query: vi.fn(async () => ({ rows: linhasDoPool, rowCount: linhasDoPool.length })),
  } as unknown as pg.Pool;
}

/** (a) o release saiu COM erro — é o único desfecho seguro para quem falhou na tx. */
function liberouComErro(cliente: ClienteFalso): void {
  expect(cliente.release, 'release deveria ser chamado UMA vez').toHaveBeenCalledTimes(1);
  const liberado = cliente.release.mock.calls[0]?.[0];
  expect(liberado, 'o cliente voltou ao pool SEM erro — é o bug da #2506').toBeInstanceOf(Error);
  expect((liberado as Error).message).toBe(MENSAGEM);
}

/** (b) caminho feliz: release sem argumento, como antes do conserto. */
function liberouSemErro(cliente: ClienteFalso): void {
  expect(cliente.release, 'release deveria ser chamado UMA vez').toHaveBeenCalledTimes(1);
  expect(cliente.release.mock.calls[0]?.[0]).toBeUndefined();
}

function comandosDaTransacao(cliente: ClienteFalso): string[] {
  return cliente.query.mock.calls.map(([sql]) => String(sql).toLowerCase().trim());
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// lib/agent-engine/queue/queue.ts — claim e conclusão de job
// ---------------------------------------------------------------------------

describe('#2506 · queue.ts (claimJobs e completeJob)', () => {
  it('claimJobs: o advisory lock que rejeita solta o cliente COM erro e o erro sobe', async () => {
    const cliente = clienteFalso('pg_advisory_xact_lock');
    const pool = poolFalso(cliente);

    await expect(claimJobs(pool, { workerId: 'w1', maxConcurrency: 2 })).rejects.toThrow(MENSAGEM);

    // Desfecho exato: begin, a consulta que rejeita, rollback e o release COM erro.
    expect(comandosDaTransacao(cliente)).toEqual([
      'begin',
      'select pg_advisory_xact_lock($1)',
      'rollback',
    ]);
    liberouComErro(cliente);
  });

  it('claimJobs: caminho feliz devolve o job e solta o cliente SEM erro', async () => {
    const cliente = clienteFalso(undefined, [['with dedup', [{ id: 'job-1' }]]]);
    const pool = poolFalso(cliente);

    const jobs = await claimJobs(pool, { workerId: 'w1', maxConcurrency: 2 });

    expect(jobs).toEqual([{ id: 'job-1' }]);
    expect(comandosDaTransacao(cliente)).toContain('commit');
    liberouSemErro(cliente);
  });

  it('completeJob: a escrita que rejeita solta o cliente COM erro e o erro sobe', async () => {
    const cliente = clienteFalso("set status = 'done'");
    const pool = poolFalso(cliente);

    await expect(completeJob(pool, 'job-1', 'w1')).rejects.toThrow(MENSAGEM);

    expect(comandosDaTransacao(cliente)).toContain('rollback');
    liberouComErro(cliente);
  });

  it('completeJob: caminho feliz commita e solta o cliente SEM erro', async () => {
    const cliente = clienteFalso();
    const pool = poolFalso(cliente);

    await completeJob(pool, 'job-1', 'w1');

    expect(comandosDaTransacao(cliente)).toContain('commit');
    liberouSemErro(cliente);
  });
});

// ---------------------------------------------------------------------------
// lib/agent-engine/guardrails/before-send.ts — lock por número + envio
// ---------------------------------------------------------------------------

function argsDoTurno(pool: pg.Pool, extras: Partial<RunBeforeSendArgs> = {}): RunBeforeSendArgs {
  return {
    pool,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    tenantId: '00000000-0000-4000-8000-000000000001',
    leadId: '00000000-0000-4000-8000-000000000002',
    jobId: '00000000-0000-4000-8000-000000000003',
    channelSessionId: '00000000-0000-4000-8000-000000000004',
    body: 'Olá! Segue o orçamento que você pediu.',
    optedOutThisTurn: false,
    crmDailyLimit: null,
    now: new Date('2026-09-17T12:00:00.000Z'),
    rng: () => 0,
    sleep: async () => {},
    gates: [],
    send: async () => ({ kind: 'sent', idempotencyKey: 'k', messageId: 'm' }),
    ...extras,
  };
}

describe('#2506 · before-send.ts (lock por número + envio)', () => {
  it('a espera do lock que rejeita solta o cliente COM erro e o erro sobe', async () => {
    const cliente = clienteFalso('pg_advisory_xact_lock');
    const pool = poolFalso(cliente);

    await expect(runBeforeSend(argsDoTurno(pool))).rejects.toThrow(MENSAGEM);

    expect(comandosDaTransacao(cliente)).toEqual([
      'begin',
      'select pg_advisory_xact_lock(hashtext($1))',
      'rollback',
    ]);
    liberouComErro(cliente);
  });

  it('caminho feliz: envia, commita e solta o cliente SEM erro', async () => {
    const cliente = clienteFalso();
    const pool = poolFalso(cliente);

    const r = await runBeforeSend(argsDoTurno(pool));

    expect(r.status).toBe('sent');
    expect(comandosDaTransacao(cliente)).toContain('commit');
    liberouSemErro(cliente);
  });
});

// ---------------------------------------------------------------------------
// lib/agent-engine/cron/scheduler.ts — transação do disparo do cron
// ---------------------------------------------------------------------------

const LOG: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const CFG: CronTickConfig = {
  batchSize: 1,
  staggerWindowMs: 60_000,
  retryBaseMs: 10_000,
  now: () => Date.parse('2026-09-17T12:00:00.000Z'),
};

const CRON_ROW = {
  id: 'cron-1',
  organization_id: '00000000-0000-4000-8000-000000000001',
  contact_id: '00000000-0000-4000-8000-000000000002',
  kind: 'every',
  interval_ms: '60000',
  cron_expr: null,
  tz: 'America/Sao_Paulo',
  job_kind: 'followup_turn',
  payload: {},
  next_run_at: new Date('2026-09-17T11:59:00.000Z'),
  enabled: true,
  attempts: 0,
  max_attempts: 5,
  last_error: null,
  created_at: new Date('2026-09-01T00:00:00.000Z'),
  updated_at: new Date('2026-09-01T00:00:00.000Z'),
  operante: true,
};

describe('#2506 · cron/scheduler.ts (fireOneDue)', () => {
  it('o select que rejeita solta o cliente COM erro e o erro sobe', async () => {
    const cliente = clienteFalso('for update skip locked');
    const pool = poolFalso(cliente);

    await expect(tickCron(pool, CFG, LOG)).rejects.toThrow(MENSAGEM);

    expect(comandosDaTransacao(cliente)).toEqual([
      'begin',
      expect.stringContaining('for update skip locked'),
      'rollback',
    ]);
    liberouComErro(cliente);
  });

  it('caminho feliz: dispara, commita e solta o cliente SEM erro', async () => {
    const cliente = clienteFalso(undefined, [
      ['from cron_jobs', [CRON_ROW]],
      ['insert into job_queue', [{ id: 'job-1' }]],
    ]);
    const pool = poolFalso(cliente);

    const tick = await tickCron(pool, CFG, LOG);

    expect(tick.fired).toBe(1);
    expect(comandosDaTransacao(cliente)).toContain('commit');
    liberouSemErro(cliente);
  });
});

// ---------------------------------------------------------------------------
// lib/agent-engine/agent/playbook-seed.ts — seed da camada platform
// ---------------------------------------------------------------------------

describe('#2506 · playbook-seed.ts (seedPlatformPlaybook)', () => {
  it('o lock que rejeita solta o cliente COM erro e o erro sobe', async () => {
    const cliente = clienteFalso('pg_advisory_xact_lock');
    const pool = poolFalso(cliente);

    await expect(seedPlatformPlaybook(pool)).rejects.toThrow(MENSAGEM);

    expect(comandosDaTransacao(cliente)).toContain('rollback');
    liberouComErro(cliente);
  });

  it('caminho feliz: ponteiro já existe, commita e solta o cliente SEM erro', async () => {
    const cliente = clienteFalso(undefined, [['playbook_pointers', [{}]]]);
    const pool = poolFalso(cliente);

    const r = await seedPlatformPlaybook(pool);

    expect(r).toBe('kept');
    expect(comandosDaTransacao(cliente)).toContain('commit');
    liberouSemErro(cliente);
  });
});

// ---------------------------------------------------------------------------
// app/api/v1/ai/cases/[id]/reply/route.ts — transição + enqueue no mesmo commit
// ---------------------------------------------------------------------------

const ORG_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const CASE_ID = '33333333-3333-4333-8333-333333333333';
const CONV_ID = '44444444-4444-4444-8444-444444444444';
const CONTACT_ID = '55555555-5555-4555-8555-555555555555';

const AUTORIZACAO: RoleCheck = {
  ok: true,
  user: {
    id: USER_ID,
    email: 'u@example.com',
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    idioma: 'pt-BR',
    organizations: [{ organization_id: ORG_ID, organization_name: 'Org', role: 'agent' }],
  } as AuthUser,
  org: { orgId: ORG_ID, name: 'Org', role: 'agent' },
};

function rotaComCliente(cliente: ClienteFalso): void {
  vi.mocked(requireRole).mockResolvedValue(AUTORIZACAO);
  vi.mocked(getRequestPool).mockReturnValue({
    query: vi.fn(async () => ({
      rows: [
        {
          status: 'awaiting_human',
          context_snapshot: null,
          title: 'Desconto especial',
          summary: 'Cliente quer 20%',
          blocker: 'Alçada',
          conversation_id: CONV_ID,
          contact_id: CONTACT_ID,
        },
      ],
      rowCount: 1,
    })),
    connect: vi.fn(async () => cliente),
  } as unknown as ReturnType<typeof getRequestPool>);
}

function requisicao(): NextRequest {
  return new NextRequest(`http://localhost/api/v1/ai/cases/${CASE_ID}/reply`, {
    method: 'POST',
    body: JSON.stringify({ action: 'need_lead_info', body: 'Qual o CPF do cliente?' }),
  });
}

async function chamarRota(): Promise<Response> {
  const { POST } = await import('@/app/api/v1/ai/cases/[id]/reply/route');
  return POST(requisicao(), { params: Promise.resolve({ id: CASE_ID }) });
}

describe('#2506 · cases/[id]/reply/route.ts (transição + enqueue)', () => {
  it('a transição que rejeita solta o cliente COM erro e o erro sobe', async () => {
    const cliente = clienteFalso();
    rotaComCliente(cliente);
    vi.mocked(markAwaitingLead).mockRejectedValue(new Error(MENSAGEM));

    await expect(chamarRota()).rejects.toThrow(MENSAGEM);

    expect(comandosDaTransacao(cliente)).toEqual(['begin', 'rollback']);
    liberouComErro(cliente);
  });

  it('caminho feliz: transiciona, enfileira, commita e solta o cliente SEM erro', async () => {
    const cliente = clienteFalso(undefined, [['insert into job_queue', [{ id: 'job-1' }]]]);
    rotaComCliente(cliente);
    vi.mocked(markAwaitingLead).mockResolvedValue(true);

    const res = await chamarRota();

    expect(res.status).toBe(200);
    // begin → insert do enqueueJob (o efeito vai no MESMO commit) → commit.
    expect(comandosDaTransacao(cliente)).toEqual([
      'begin',
      expect.stringContaining('insert into job_queue'),
      'commit',
    ]);
    liberouSemErro(cliente);
  });
});
