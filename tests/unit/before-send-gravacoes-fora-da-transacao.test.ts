/**
 * #2426 — nenhuma escrita com FK para `contacts` sai por OUTRA conexão enquanto a
 * transação de `runBeforeSend` está aberta.
 *
 * O #2121 tirou o classificador semântico de promessa de dentro da transação, encerrando a
 * aresta principal do ciclo medido no #2363 (`idle in transaction` por 8m47s, worker parado,
 * ~10 min de 503). Mas outras gravações ainda saíam pelo `args.pool` — OUTRA conexão — enquanto
 * a tx aberta segurava `contacts` (readStopFlags) sob o `pg_advisory_xact_lock` do número. Com um
 * DDL pendente em `contacts`, essas gravações enfileiravam atrás dele: o insert esperava o DDL,
 * o DDL esperava a tx e a tx esperava o insert — um ciclo que o Postgres não detecta porque uma
 * das arestas mora no Node. `before_send_traces` (persistTrace) é uma dessas arestas.
 *
 * A régua que este arquivo vira mecanismo: o `runBeforeSend` NÃO pode emitir nenhum `insert`/
 * `update`/`delete` pelo pool enquanto a transação do cliente está aberta (entre `begin` e
 * `commit`/`rollback`). As escritas duráveis (trace, timeline do veto, escalação LGPD) passaram
 * a acontecer DEPOIS do commit/rollback — autônomas no pool, sobrevivem ao rollback por natureza.
 *
 * Nasce VERMELHO: antes do conserto, `persistTrace` gravava `before_send_traces` pelo pool
 * DURANTE a tx (caminho enviado), e no veto as três escritas duráveis (trace + timeline +
 * escalação LGPD) rodavam antes do rollback. A sabotagem (reverter só o before-send.ts) reprova
 * os 3 casos daqui.
 *
 * O QUE NÃO É MEDIDO AQUI (declarado também no PR): o `args.send` continua DENTRO da tx, sob o
 * advisory lock do número (serialização anti-ban). O `send_ledger` e a `messages`, gravados pelo
 * handler noutra conexão/Supabase dentro do `send`, seguem sendo uma aresta possível de ciclo —
 * fechá-la exige o advisory lock de SESSÃO proposto no próprio #2426, que precisa de prova com 2
 * conexões (job `invariants`) e não cabe nesta fatia.
 */
import type pg from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  runBeforeSend,
  type Gate,
  type RunBeforeSendArgs,
} from '@/lib/agent-engine/guardrails/before-send';

/** Estado compartilhado entre o cliente (que abre/fecha a tx) e o pool (que audita). */
interface EstadoTransacao {
  aberta: boolean;
}

/**
 * Cliente fake que espia o ciclo da transação: `begin` abre, `commit`/`rollback` fecham.
 * As leituras sob o lock devolvem linhas vazias — todos os loaders têm default para vazio
 * (o caminho feliz do #2506 já prova que `runBeforeSend` completa assim).
 */
function clienteComTransacao(): { cliente: pg.PoolClient; estado: EstadoTransacao } {
  const estado: EstadoTransacao = { aberta: false };
  const cliente = {
    query: vi.fn(async (sql: string) => {
      const s = String(sql).toLowerCase().trim();
      if (s === 'begin') estado.aberta = true;
      if (s === 'commit' || s === 'rollback') estado.aberta = false;
      return { rows: [], rowCount: 1 };
    }),
    release: vi.fn(),
  };
  return { cliente: cliente as unknown as pg.PoolClient, estado };
}

/**
 * Pool fake (a "outra conexão"). Toda escrita (`insert`/`update`/`delete`) é registrada; se ela
 * acontece com a transação ABERTA, entra em `violacoes` — é exatamente a aresta do #2426. O insert
 * em `before_send_traces` devolve um `id` para o caminho do veto exercitar a timeline.
 */
function poolAuditoriado(
  cliente: pg.PoolClient,
  estado: EstadoTransacao,
): { pool: pg.Pool; violacoes: string[]; escritas: string[] } {
  const violacoes: string[] = [];
  const escritas: string[] = [];
  const pool = {
    connect: vi.fn(async () => cliente),
    query: vi.fn(async (sql: string) => {
      const s = String(sql).toLowerCase().trim();
      if (/^(insert|update|delete)\b/.test(s)) {
        escritas.push(s);
        if (estado.aberta) violacoes.push(s);
      }
      if (s.includes('insert into before_send_traces'))
        return { rows: [{ id: 'trace-1' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }),
  };
  return { pool: pool as unknown as pg.Pool, violacoes, escritas };
}

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

/** Gate que veta sempre — para exercitar o caminho do veto (trace + timeline + escalação). */
function gateQueVeta(code: string): Gate {
  return { name: 'gate_de_teste', evaluate: () => ({ pass: false, code, reason: 'veto de teste' }) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('#2426 · runBeforeSend não grava pelo pool enquanto a transação está aberta', () => {
  it('caminho enviado: o trace sai DEPOIS do commit, nunca durante a transação', async () => {
    const { cliente, estado } = clienteComTransacao();
    const { pool, violacoes, escritas } = poolAuditoriado(cliente, estado);

    const r = await runBeforeSend(argsDoTurno(pool));

    expect(r.status).toBe('sent');
    // A régua: nenhuma escrita pelo pool com a tx aberta.
    expect(violacoes, 'escrita pelo pool durante a transação aberta (#2426)').toEqual([]);
    // A auditoria continua existindo — só mudou o momento: depois do commit.
    expect(escritas.some((s) => s.includes('insert into before_send_traces'))).toBe(true);
  });

  it('veto (LGPD): trace + timeline + escalação saem DEPOIS do rollback, nunca durante a transação', async () => {
    const { cliente, estado } = clienteComTransacao();
    const { pool, violacoes, escritas } = poolAuditoriado(cliente, estado);

    const r = await runBeforeSend(
      argsDoTurno(pool, { gates: [gateQueVeta('lgpd_anonymized')] }),
    );

    expect(r.status).toBe('vetoed');
    expect(violacoes, 'escrita pelo pool durante a transação aberta (#2426)').toEqual([]);
    // O trace do veto é gravado (sobrevive ao rollback) — e o código lgpd_ dispara a escalação.
    expect(escritas.some((s) => s.includes('insert into before_send_traces'))).toBe(true);
    expect(escritas.some((s) => s.includes('insert into agent_inbox_items'))).toBe(true);
  });

  it('envio que ERRA: a auditoria é gravada depois do rollback, sem escrita pela transação aberta', async () => {
    const { cliente, estado } = clienteComTransacao();
    const { pool, violacoes, escritas } = poolAuditoriado(cliente, estado);

    await expect(
      runBeforeSend(
        argsDoTurno(pool, {
          send: async () => {
            throw new Error('transporte fora');
          },
        }),
      ),
    ).rejects.toThrow('transporte fora');

    expect(violacoes, 'escrita pelo pool durante a transação aberta (#2426)').toEqual([]);
    // A tentativa que errou ainda tem linha de auditoria (autônoma, pós-rollback).
    expect(escritas.some((s) => s.includes('insert into before_send_traces'))).toBe(true);
  });
});
