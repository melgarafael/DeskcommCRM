import { readFileSync } from 'node:fs';

import { describe, it, expect } from 'vitest';
import type pg from 'pg';

import { applyScheduleFollowup } from './schedule-followup';

/**
 * Pool fake: roteia por conteúdo da SQL. O guard anti-empilhamento faz um SELECT
 * (`enabled = true`); a criação faz o INSERT (`insert into cron_jobs`). Cada teste
 * decide o que o SELECT devolve — com ou sem pendente.
 */
function fakePool(pendentes: Array<{ id: string; promised_at: string | null }>): {
  db: pg.Pool;
  inserts: number;
} {
  let inserts = 0;
  const db = {
    async query(sql: string) {
      if (/insert into cron_jobs/i.test(sql)) {
        inserts += 1;
        return { rows: [{ id: 'cron-novo', next_run_at: new Date('2026-07-25T13:00:00Z') }] };
      }
      // guard SELECT
      return { rows: pendentes };
    },
  } as unknown as pg.Pool;
  return { db, get inserts() { return inserts; } } as { db: pg.Pool; inserts: number };
}

const CFG = {
  clock: () => new Date('2026-07-23T12:00:00Z'),
  knobs: { minAheadMs: 30 * 60_000, maxAheadMs: 30 * 86_400_000, staggerWindowMs: 60_000 },
};
const IDS = { tenantId: 'org-1', leadId: 'lead-1' };
const VALID = {
  reason: 'reconfirmar call',
  promised_at: '2026-07-25T13:00:00Z',
  promise: 'confirmar a call de diagnóstico',
  context_snapshot: null,
};

describe('applyScheduleFollowup — guard anti-empilhamento (1 pendente por lead)', () => {
  it('lead JÁ tem follow-up pendente → already_pending, NÃO cria segundo', async () => {
    const p = fakePool([{ id: 'cron-existente', promised_at: '2026-07-25T10:00:00Z' }]);
    const res = await applyScheduleFollowup(p.db, CFG, IDS, VALID);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('esperava falha');
    expect(res.error.code).toBe('already_pending');
    expect(res.error.message).toContain('2026-07-25T10:00:00Z');
    expect(p.inserts).toBe(0); // o insert do cron NÃO rodou — sem empilhar
  });

  it('lead SEM pendente → agenda normalmente (cria 1)', async () => {
    const p = fakePool([]);
    const res = await applyScheduleFollowup(p.db, CFG, IDS, VALID);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('esperava sucesso');
    expect(res.cronJobId).toBe('cron-novo');
    expect(p.inserts).toBe(1);
  });

  it('o ensino manda usar data ABSOLUTA (anti "amanhã")', async () => {
    const p = fakePool([{ id: 'x', promised_at: null }]);
    const res = await applyScheduleFollowup(p.db, CFG, IDS, VALID);
    if (res.ok) throw new Error('esperava falha');
    expect(res.error.message.toLowerCase()).toContain('absoluta');
    expect(res.error.message).toContain('amanhã');
  });
});

/**
 * O retorno nativo recebe o que só `crm_schedule_followup` tinha: a escolha do
 * NEGÓCIO (`lead_id`) em que a linha da timeline cai. O alvo do retorno não muda
 * — é sempre o contato do runtime; `lead_id` só escolhe ENTRE os negócios
 * principais dele, e o que não serve cai no roteamento de sempre, agendando.
 *
 * Pool fake que responde também à consulta de candidatos de
 * `emitAgentActivityForContact` e captura os dois inserts.
 */
const ORG = 'org-1';
const CANDIDATOS = [
  // A: principal, aberto, atividade antiga
  { id: 'lead-a', organization_id: ORG, pipeline_id: 'p1', status: 'open', last_activity_at: '2026-07-01T00:00:00Z', created_at: '2026-06-01T00:00:00Z', via: 'principal' },
  // B: principal, aberto, atividade mais recente — o que o roteamento escolhe
  { id: 'lead-b', organization_id: ORG, pipeline_id: 'p1', status: 'open', last_activity_at: '2026-07-20T00:00:00Z', created_at: '2026-06-02T00:00:00Z', via: 'principal' },
  // R: só relacionado
  { id: 'lead-r', organization_id: ORG, pipeline_id: 'p1', status: 'open', last_activity_at: '2026-07-22T00:00:00Z', created_at: '2026-06-03T00:00:00Z', via: 'relacionado' },
  // C: principal, aberto, mas noutro FUNIL (p2), fora do escopo do agente
  { id: 'lead-c', organization_id: ORG, pipeline_id: 'p2', status: 'open', last_activity_at: '2026-07-10T00:00:00Z', created_at: '2026-06-04T00:00:00Z', via: 'principal' },
];
/** O escopo de funil do agente: só `p1`. */
const ESCOPO = ['p1'];

function poolComNegocios() {
  const cron: unknown[][] = [];
  const atividades: unknown[][] = [];
  const db = {
    async query(sql: string, params: unknown[] = []) {
      if (/insert into cron_jobs/i.test(sql)) {
        cron.push(params);
        return { rows: [{ id: 'cron-novo', next_run_at: new Date('2026-07-25T13:00:00Z') }] };
      }
      if (/insert into crm_lead_activities/i.test(sql)) {
        atividades.push(params);
        return { rows: [] };
      }
      if (/from crm_leads l/i.test(sql)) return { rows: CANDIDATOS };
      return { rows: [] }; // guard sem pendente, pipeline default ausente, event_log
    },
  } as unknown as pg.Pool;
  return { db, cron, atividades };
}

async function negocioDaLinha(
  leadId: string | undefined,
  // `null` = o campo AUSENTE (agente sem configuração); `undefined` cairia no default.
  pipelineIds: readonly string[] | null = ESCOPO,
) {
  const p = poolComNegocios();
  const res = await applyScheduleFollowup(
    p.db,
    CFG,
    { tenantId: ORG, leadId: 'contato-1', ...(pipelineIds !== null ? { pipelineIds } : {}) },
    leadId === undefined ? VALID : { ...VALID, lead_id: leadId },
  );
  expect(res.ok, JSON.stringify(res)).toBe(true);
  // O retorno é sempre do CONTATO do runtime, nunca do que o modelo mandou.
  expect(p.cron).toHaveLength(1);
  expect(p.cron[0]![1]).toBe('contato-1');
  expect(p.atividades).toHaveLength(1);
  return p.atividades[0]![1]; // lead_id da linha da timeline
}

describe('applyScheduleFollowup — lead_id escolhe o negócio da timeline', () => {
  it('⭐ lead_id de um negócio principal deste cliente: a linha cai nele', async () => {
    expect(await negocioDaLinha('lead-a')).toBe('lead-a');
  });

  it('lead_id que não é deste cliente: agenda mesmo assim, e o roteamento decide', async () => {
    expect(await negocioDaLinha('lead-de-outro-cliente')).toBe('lead-b');
  });

  it('lead_id de negócio só relacionado: não vale, o roteamento decide', async () => {
    expect(await negocioDaLinha('lead-r')).toBe('lead-b');
  });

  it('controle: sem lead_id, o roteamento de sempre', async () => {
    expect(await negocioDaLinha(undefined)).toBe('lead-b');
  });

  // A do catálogo passa o mesmo `lead_id` pelo gate de funil (`funil_vem_do_lead`).
  // A variante nativa não pode ser a porta que o contorna.
  it('⭐ lead_id de negócio principal num funil FORA do escopo: o roteamento decide', async () => {
    expect(await negocioDaLinha('lead-c')).toBe('lead-b');
  });

  it('controle: o mesmo negócio, com o funil dele no escopo, vale', async () => {
    expect(await negocioDaLinha('lead-c', ['p1', 'p2'])).toBe('lead-c');
  });

  it('escopo vazio (NENHUM funil) ou ausente: lead_id ignorado, o roteamento decide', async () => {
    expect(await negocioDaLinha('lead-a', [])).toBe('lead-b');
    expect(await negocioDaLinha('lead-a', null)).toBe('lead-b');
  });

  // Sem harness do turno sem banco (ver duplicata-nativa-some-do-turno-mcp.test.ts),
  // a ligação é guardada pela FONTE: sem os funis, o gate acima vira "escopo vazio"
  // e o `lead_id` é sempre ignorado — seguro, mas a escolha do negócio morre calada.
  it('a ligação no turno passa os funis do agente (guarda de fonte)', () => {
    const fonte = readFileSync('lib/agent-engine/agent/inbound-turn.ts', 'utf8');
    const i = fonte.indexOf('await applyScheduleFollowup(');
    expect(i, 'âncora `await applyScheduleFollowup(` sumiu do turno').toBeGreaterThan(-1);
    expect(fonte.slice(i, fonte.indexOf('raw,', i))).toMatch(
      /pipelineIds: agentConfig\?\.pipelineIds \?\? null/,
    );
  });
});
