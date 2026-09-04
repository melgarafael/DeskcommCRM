import { expect, it, vi } from 'vitest';
import type pg from 'pg';

import { drainTick } from './drain';

const knobs = { batchSize: 10, intervalMs: 0, idleIntervalMs: 0, debounceMs: 0, reapTimeoutMs: 60000 };
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
const event = {
  id: 'e1', organization_id: 'org1', attempts: 1,
  payload: {
    conversation_id: '11111111-1111-4111-8111-111111111111',
    contact_id: '22222222-2222-4222-8222-222222222222',
    channel_session_id: '33333333-3333-4333-8333-333333333333',
    inbound_message_id: '44444444-4444-4444-8444-444444444444',
  },
};

it('org em ai_dispatch_mode=external: evento vira done SEM enfileirar job', async () => {
  const calls: string[] = [];
  const query = vi.fn().mockImplementation((sql: string) => {
    calls.push(sql);
    if (sql.includes('returning e.id')) return { rows: [event] };            // claim
    if (sql.includes("ai_dispatch_mode")) return { rows: [{ mode: 'external' }] }; // guard
    if (sql.includes('is_group')) return { rows: [{ is_group: false }] };
    return { rows: [] };                                                      // reaper / done
  });
  await drainTick({ query } as unknown as pg.Pool, knobs, log);
  // o guard TEM que consultar o modo (garante FAIL antes da implementação)...
  expect(calls.some((s) => s.includes('ai_dispatch_mode'))).toBe(true);
  // ...e nenhum job pode ser enfileirado (enqueueJob nunca roda).
  expect(calls.some((s) => s.includes('job_queue'))).toBe(false);
  expect(calls.some((s) => s.includes("status = 'done'"))).toBe(true);
});

/**
 * Áudio: o turno não pode ser despachado antes de a transcrição existir.
 *
 * Defeito de origem, medido em VPS: o dispatch saía no mesmo instante em que a
 * mensagem chegava (20:24:22) e a derivação da mídia só era pedida depois
 * (20:25:03). O cliente recebia "recebi seu áudio, mas não consigo ouvi-lo"
 * segundos ANTES de a transcrição ficar pronta.
 */
const eventoDeAudio = (criadoHaMs: number) => ({
  ...event,
  created_at: new Date(Date.now() - criadoHaMs).toISOString(),
});

function poolFalso(
  msgRow: { type: string; media_derived_status: string | null },
  calls: string[],
  capacidade: { tem_agente: boolean; tem_roteador: boolean } = { tem_agente: true, tem_roteador: false },
) {
  const query = vi.fn().mockImplementation((sql: string) => {
    calls.push(sql);
    if (sql.includes('returning e.id')) return { rows: [eventoDeAudio(Number(process.env.__ESPERA__ ?? 0))] };
    if (sql.includes('ai_dispatch_mode')) return { rows: [{ mode: null }] };
    if (sql.includes('is_group')) return { rows: [{ is_group: false }] };
    if (sql.includes('tem_agente')) return { rows: [capacidade] };
    if (sql.includes('media_derived_status')) return { rows: [msgRow] };
    return { rows: [] };
  });
  return { query } as unknown as pg.Pool;
}

it('áudio ainda sem transcrição: turno é ADIADO, sem enfileirar job', async () => {
  const calls: string[] = [];
  process.env.__ESPERA__ = '1000'; // chegou há 1s — dentro do teto
  await drainTick(poolFalso({ type: 'audio', media_derived_status: null }, calls), knobs, log);
  expect(calls.some((s) => s.includes('media_derived_status'))).toBe(true);
  expect(calls.some((s) => s.includes('job_queue'))).toBe(false);
  expect(calls.some((s) => s.includes("status = 'pending'") && s.includes('next_attempt_at'))).toBe(true);
  expect(calls.some((s) => s.includes("status = 'done'"))).toBe(false);
});

it('áudio JÁ transcrito: turno segue normalmente', async () => {
  const calls: string[] = [];
  process.env.__ESPERA__ = '1000';
  await drainTick(poolFalso({ type: 'audio', media_derived_status: 'ready' }, calls), knobs, log);
  expect(calls.some((s) => s.includes('job_queue'))).toBe(true);
});

it('derivação travada além do teto: segue SEM o texto em vez de deixar o cliente esperando', async () => {
  const calls: string[] = [];
  process.env.__ESPERA__ = '150000'; // 150s — muito além do teto de 120s
  await drainTick(poolFalso({ type: 'audio', media_derived_status: null }, calls), knobs, log);
  expect(calls.some((s) => s.includes('job_queue'))).toBe(true);
});

it('mensagem de texto não espera nada', async () => {
  const calls: string[] = [];
  process.env.__ESPERA__ = '0';
  await drainTick(poolFalso({ type: 'text', media_derived_status: null }, calls), knobs, log);
  expect(calls.some((s) => s.includes('job_queue'))).toBe(true);
});


/**
 * Agente pausado não pode custar dinheiro.
 *
 * Medido em VPS com o agente despublicado pela tela: UMA mensagem rodou o
 * pipeline inteiro — 6 chamadas ao LLM, ~2 centavos — e ainda produziu
 * resposta. "Pausei o agente" tem que significar "parou de gastar".
 */
const textoSimples = { type: 'text', media_derived_status: null };

it('sem agente publicado e sem roteador: turno pulado ANTES de qualquer gasto', async () => {
  const calls: string[] = [];
  process.env.__ESPERA__ = '0';
  await drainTick(
    poolFalso(textoSimples, calls, { tem_agente: false, tem_roteador: false }),
    knobs, log,
  );
  expect(calls.some((s) => s.includes('tem_agente'))).toBe(true);
  expect(calls.some((s) => s.includes('job_queue'))).toBe(false);
  expect(calls.some((s) => s.includes("status = 'done'"))).toBe(true);
});

it('com agente publicado: turno segue', async () => {
  const calls: string[] = [];
  process.env.__ESPERA__ = '0';
  await drainTick(
    poolFalso(textoSimples, calls, { tem_agente: true, tem_roteador: false }),
    knobs, log,
  );
  expect(calls.some((s) => s.includes('job_queue'))).toBe(true);
});

it('sem agente MAS com roteador que resolve alguém: turno segue (caminho genérico preservado)', async () => {
  const calls: string[] = [];
  process.env.__ESPERA__ = '0';
  await drainTick(
    poolFalso(textoSimples, calls, { tem_agente: false, tem_roteador: true }),
    knobs, log,
  );
  expect(calls.some((s) => s.includes('job_queue'))).toBe(true);
});

/**
 * Anti-backlog + gate de elegibilidade (migration 0203).
 *
 * `poolElegibilidade` estende o pool falso com as duas consultas novas: a de
 * supersessão (última inbound da conversa) e a de elegibilidade (gate do canal
 * + travas do contato).
 */
function poolElegibilidade(
  calls: string[],
  opts: {
    ultimaInboundId?: string;
    aiGate?: string | null;
    aiAuthorizedAt?: string | null;
    forceHuman?: boolean;
    assigneeKind?: string | null;
  } = {},
) {
  const inboundId = '44444444-4444-4444-8444-444444444444';
  const query = vi.fn().mockImplementation((sql: string) => {
    calls.push(sql);
    if (sql.includes('returning e.id')) return { rows: [{ ...event, created_at: new Date().toISOString() }] };
    if (sql.includes('ai_dispatch_mode')) return { rows: [{ mode: null }] };
    if (sql.includes('is_group')) return { rows: [{ is_group: false }] };
    if (sql.includes('tem_agente')) return { rows: [{ tem_agente: true, tem_roteador: false }] };
    if (sql.includes("direction = 'inbound'")) {
      return { rows: [{ id: opts.ultimaInboundId ?? inboundId }] };
    }
    if (sql.includes("->>'ai_gate'")) {
      return {
        rows: [
          {
            ai_gate: opts.aiGate ?? null,
            force_human: opts.forceHuman ?? false,
            assignee_kind: opts.assigneeKind ?? 'ai',
            bot_silenced_until: null,
            ai_authorized_at: opts.aiAuthorizedAt ?? null,
          },
        ],
      };
    }
    if (sql.includes('media_derived_status')) return { rows: [{ type: 'text', media_derived_status: null }] };
    return { rows: [] };
  });
  return { query } as unknown as pg.Pool;
}

it('evento superado por inbound mais recente: turno pulado, sem job, sem gasto', async () => {
  const calls: string[] = [];
  await drainTick(poolElegibilidade(calls, { ultimaInboundId: 'outra-mensagem-mais-nova' }), knobs, log);
  expect(calls.some((s) => s.includes("direction = 'inbound'"))).toBe(true);
  expect(calls.some((s) => s.includes('job_queue'))).toBe(false);
  expect(calls.some((s) => s.includes("status = 'done'"))).toBe(true);
});

it("gate 'allowlist' + contato NÃO autorizado: turno pulado, sem job, sem gasto", async () => {
  const calls: string[] = [];
  await drainTick(poolElegibilidade(calls, { aiGate: 'allowlist', aiAuthorizedAt: null }), knobs, log);
  expect(calls.some((s) => s.includes("->>'ai_gate'"))).toBe(true);
  expect(calls.some((s) => s.includes('job_queue'))).toBe(false);
  expect(calls.some((s) => s.includes("status = 'done'"))).toBe(true);
});

it("gate 'allowlist' + contato autorizado agora: turno segue", async () => {
  const calls: string[] = [];
  await drainTick(
    poolElegibilidade(calls, { aiGate: 'allowlist', aiAuthorizedAt: new Date().toISOString() }),
    { ...knobs, allowlistTtlMs: 21 * 24 * 60 * 60 * 1000 },
    log,
  );
  expect(calls.some((s) => s.includes('job_queue'))).toBe(true);
});

it("gate 'allowlist' + autorização EXPIRADA (fora do TTL): turno pulado", async () => {
  const calls: string[] = [];
  const antiga = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
  await drainTick(
    poolElegibilidade(calls, { aiGate: 'allowlist', aiAuthorizedAt: antiga }),
    { ...knobs, allowlistTtlMs: 21 * 24 * 60 * 60 * 1000 },
    log,
  );
  expect(calls.some((s) => s.includes('job_queue'))).toBe(false);
  expect(calls.some((s) => s.includes("status = 'done'"))).toBe(true);
});

it("gate 'open' (default): contato sem autorização NÃO é barrado — comportamento de hoje", async () => {
  const calls: string[] = [];
  await drainTick(poolElegibilidade(calls, { aiGate: null, aiAuthorizedAt: null }), knobs, log);
  expect(calls.some((s) => s.includes('job_queue'))).toBe(true);
});

it("gate 'allowlist' + force_human: turno pulado mesmo com autorização", async () => {
  const calls: string[] = [];
  await drainTick(
    poolElegibilidade(calls, {
      aiGate: 'allowlist',
      aiAuthorizedAt: new Date().toISOString(),
      forceHuman: true,
    }),
    knobs,
    log,
  );
  expect(calls.some((s) => s.includes('job_queue'))).toBe(false);
});

/**
 * R7 — a consulta da "última inbound" (anti-backlog) desempata por recência
 * REAL, nunca por `id` (uuid aleatório). `order by sent_at desc nulls last, id
 * desc` elegia a mensagem ANTIGA por sorteio quando dois inbound tinham o mesmo
 * `sent_at`. A cerca guarda a cláusula seguindo o padrão do repo (migration
 * 0027): `coalesce(sent_at, created_at)`.
 */
it("anti-backlog: ordena a última inbound por coalesce(sent_at, created_at), não por id sozinho", async () => {
  const calls: string[] = [];
  await drainTick(poolElegibilidade(calls), knobs, log);
  const consultaUltima = calls.find((s) => s.includes("direction = 'inbound'"));
  expect(consultaUltima).toBeDefined();
  expect(consultaUltima).toContain('coalesce(sent_at, created_at) desc');
  expect(consultaUltima).not.toContain('nulls last');
});
