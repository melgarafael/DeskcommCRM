import { expect, it, vi } from 'vitest';
import type pg from 'pg';

import { drainTick } from './drain';

/**
 * A QUARENTENA NO DRENO DO TURNO (#4026, fatia 1).
 *
 * ─── Por que não basta o gate da ingestão ──────────────────────────────────
 *
 * `aplicarEfeitosPosEntrada` só roda no instante em que a mensagem chega. O
 * evento `ai_agent.dispatch_requested` tem consumidor próprio (este dreno, que
 * NÃO passa pelo registry do `event_log`) e pode ser consumido muito depois:
 * debounce de rajada, janela de resposta fechada, fila do worker parada. Marcar
 * a mensagem nesse intervalo tem de calar a IA — senão a quarentena só
 * funcionaria para quem marcasse antes do webhook, que não é o caso real.
 *
 * Este é o único ponto do caminho do turno: um `if` depois dos gates que já
 * existem (organização, canal desativado, grupo) e antes de qualquer gasto.
 *
 * ─── SABOTAGEM ─────────────────────────────────────────────────────────────
 *
 * · tirar o gate: o primeiro caso acusa (`job_queue` aparece e o turno é
 *   enfileirado para uma mensagem em quarentena);
 * · trocar o fail-open por fail-closed: o caso da leitura que lança acusa (o
 *   drain pararia de enfileirar conversas normais por causa de um erro de
 *   leitura).
 */

const knobs = { batchSize: 10, intervalMs: 0, idleIntervalMs: 0, debounceMs: 0, reapTimeoutMs: 60000 };
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

const event = {
  id: 'e1',
  organization_id: 'org1',
  attempts: 1,
  payload: {
    conversation_id: '11111111-1111-4111-8111-111111111111',
    contact_id: '22222222-2222-4222-8222-222222222222',
    channel_session_id: '33333333-3333-4333-8333-333333333333',
    inbound_message_id: '44444444-4444-4444-8444-444444444444',
  },
};

/** Dublê do pool: responde por SQL, como os testes vizinhos. */
function poolFalso(quarentenaResposta: { rows: unknown[] } | Error, calls: string[]) {
  return {
    query: vi.fn().mockImplementation((sql: string) => {
      calls.push(sql);
      if (sql.includes('returning e.id')) return { rows: [event] }; // claim
      if (sql.includes('ai_dispatch_mode')) return { rows: [{ mode: null, status: 'active' }] };
      if (sql.includes('is_group')) return { rows: [{ is_group: false }] };
      if (sql.includes('quarantined_at')) {
        if (quarentenaResposta instanceof Error) throw quarentenaResposta;
        return quarentenaResposta;
      }
      if (sql.includes('tem_agente')) return { rows: [{ tem_agente: true, tem_roteador: false }] };
      return { rows: [] };
    }),
  } as unknown as pg.Pool;
}

it('mensagem em quarentena: evento vira done SEM enfileirar turno', async () => {
  const calls: string[] = [];
  const pool = poolFalso({ rows: [{ quarantined_at: '2026-11-05T12:00:00.000Z' }] }, calls);

  await drainTick(pool, knobs, log);

  // A consulta da marca tem de acontecer (senão o gate não existe)…
  expect(calls.some((s) => s.includes('quarantined_at'))).toBe(true);
  // …e nenhum job pode ser criado para esta mensagem.
  expect(calls.some((s) => s.includes('job_queue')), 'o turno foi enfileirado em quarentena').toBe(false);
  expect(calls.some((s) => s.includes("status = 'done'"))).toBe(true);
  expect((log as unknown as { info: ReturnType<typeof vi.fn> }).info).toHaveBeenCalledWith(
    expect.stringContaining('quarentena'),
    expect.objectContaining({ inbound_message_id: event.payload.inbound_message_id }),
  );
});

it('mensagem SEM marca segue o caminho de sempre (não para no gate)', async () => {
  const calls: string[] = [];
  const pool = poolFalso({ rows: [{ quarantined_at: null }] }, calls);

  await drainTick(pool, knobs, log);

  expect(calls.some((s) => s.includes('quarantined_at'))).toBe(true);
  // Passou do gate: chegou a perguntar quem atende a sessão, que é o passo
  // seguinte e o primeiro que pode gastar. O job em si depende de mais estado
  // (agente publicado, derivação de mídia) e tem teste próprio no vizinho.
  expect(calls.some((s) => s.includes('tem_agente'))).toBe(true);
});

it('FALHA ao ler a marca é fail-open: o turno segue', async () => {
  // Perder a resposta de uma conversa legítima por um timeout é pior do que o
  // comportamento de hoje — o gate é filtro, não disponibilidade.
  const calls: string[] = [];
  const pool = poolFalso(new Error('timeout'), calls);

  await drainTick(pool, knobs, log);

  expect(calls.some((s) => s.includes('tem_agente'))).toBe(true);
});
