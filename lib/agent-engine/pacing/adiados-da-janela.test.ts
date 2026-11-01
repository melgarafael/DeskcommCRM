/**
 * O RASTRO E OS DOIS ACORDAMENTOS DO #3383.
 *
 * "Mudar a janela de resposta não solta turnos já adiados, e mensagens novas do
 * contato ficam presas neles." Este arquivo trava as PEÇAS que consertam isso:
 *
 *  - `adiadoPorJanela` / `adiadoPelaJanelaDeResposta`: o rastro que
 *    `inbound-turn.ts` grava no job que adiou, sem o qual o drain não sabe que
 *    aquele `run_after` futuro é uma ABERTURA e não um debounce;
 *  - `soltarAdiadosDaSessao`: a reavaliação do `PUT /api/v1/ai/pacing` — com a
 *    janela ABERTA ela acorda; com a janela FECHADA ninguém é mexido (cenário
 *    B, regressão zero) e a leitura que falha também não mexe (fail-closed);
 *  - `soltarAdiadoPelaJanela`: o acordar pelo drain, com os predicados de
 *    idempotência que impedem o MESMO turno de disparar duas vezes.
 *
 * O relógio é fixo (`AS_22H11`) porque a janela é uma hora local do tenant: o
 * teste tem de medir 22h11 em São Paulo, não a hora do runner.
 */
import { expect, it, vi } from 'vitest';
import type pg from 'pg';

import {
  adiadoPelaJanelaDeResposta,
  adiadoPorJanela,
  janelaDeRespostaAberta,
  soltarAdiadoPelaJanela,
  soltarAdiadosDaSessao,
} from './adiados-da-janela';

const ORG = '11111111-1111-4111-8111-111111111111';
const SESSAO = '22222222-2222-4222-8222-222222222222';
/** Terça, 22h11 em São Paulo — fora da janela 7h–22h, dentro de 0h–24h. */
const AS_22H11 = new Date('2026-07-28T01:11:00Z');

/** Linha de `channel_knobs` como `loadChannelKnobs` a lê (left join + fuso da org). */
function knobsRow(respostaStartHour: number | null, respostaEndHour: number | null) {
  return {
    throttle_ms: null,
    jitter_max_ms: null,
    window_start_hour: null,
    window_end_hour: null,
    resposta_start_hour: respostaStartHour,
    resposta_end_hour: respostaEndHour,
    atraso_notar_ms: null,
    ms_por_caractere: null,
    atraso_minimo_ms: null,
    atraso_maximo_ms: null,
    allow_sunday: null,
    prospeccao_dias: null,
    timezone: 'America/Sao_Paulo',
    warmup_daily_caps: null,
    number_activated_at: null,
    org_timezone: null,
  };
}

/** Pool falso no padrão do repo: responde por leitura do SQL e guarda as chamadas. */
function poolFalso(opts: { row?: unknown; leituraFalha?: boolean } = {}) {
  const chamadas: string[] = [];
  const query = vi.fn().mockImplementation((sql: string) => {
    chamadas.push(sql);
    if (sql.includes('k.resposta_start_hour')) {
      if (opts.leituraFalha) throw new Error('banco indisponível');
      return { rows: opts.row === undefined ? [] : [opts.row], rowCount: 1 };
    }
    if (sql.includes('update job_queue')) return { rows: [{ id: 'job-1' }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  return { pool: { query } as unknown as pg.Pool, chamadas };
}

// ── O rastro ───────────────────────────────────────────────────────────────

it('adiadoPorJanela grava a chave com tipo, abertura e janela — é o payloadPatch do rescheduleJob', () => {
  const rastro = adiadoPorJanela({
    tipo: 'resposta',
    abertura: '2026-07-29T10:00:00.000Z',
    janela: '7h-22h',
  });
  expect(rastro).toEqual({
    adiado_por_janela: { tipo: 'resposta', abertura: '2026-07-29T10:00:00.000Z', janela: '7h-22h' },
  });
});

it('adiadoPelaJanelaDeResposta só aceita o rastro da JANELA DE RESPOSTA', () => {
  expect(adiadoPelaJanelaDeResposta({ adiado_por_janela: { tipo: 'resposta' } })).toBe(true);
  // Retomada adiada pela janela de DISPARO: não é assunto deste fix.
  expect(adiadoPelaJanelaDeResposta({ adiado_por_janela: { tipo: 'disparo' } })).toBe(false);
  // Job de debounce, cap, saldo, sessão: sem rastro, comportamento de sempre.
  expect(adiadoPelaJanelaDeResposta({ conversation_id: 'c1' })).toBe(false);
  expect(adiadoPelaJanelaDeResposta(undefined)).toBe(false);
  expect(adiadoPelaJanelaDeResposta(null)).toBe(false);
  expect(adiadoPelaJanelaDeResposta('held_run_after')).toBe(false);
});

// ── A leitura da janela (a mesma régua do motor, fuso do tenant) ───────────

it('janelaDeRespostaAberta: 0h–24h está aberta às 22h11, 7h–22h não está', async () => {
  const aberta = poolFalso({ row: knobsRow(0, 24) });
  expect(
    await janelaDeRespostaAberta(aberta.pool, {
      organizationId: ORG,
      channelSessionId: SESSAO,
      agora: AS_22H11,
    }),
  ).toBe(true);

  const fechada = poolFalso({ row: knobsRow(7, 22) });
  expect(
    await janelaDeRespostaAberta(fechada.pool, {
      organizationId: ORG,
      channelSessionId: SESSAO,
      agora: AS_22H11,
    }),
  ).toBe(false);
});

it('janelaDeRespostaAberta: leitura que falha devolve false — quem não sabe não decide que abriu', async () => {
  const pool = poolFalso({ leituraFalha: true });
  expect(
    await janelaDeRespostaAberta(pool.pool, {
      organizationId: ORG,
      channelSessionId: SESSAO,
      agora: AS_22H11,
      log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as never,
    }),
  ).toBe(false);
});

// ── O acordar do PUT /api/v1/ai/pacing (cenário C) ────────────────────────

it('cenário C: janela aberta para 0h–24h — o PUT acorda os turnos adiados da conexão', async () => {
  const { pool, chamadas } = poolFalso({ row: knobsRow(0, 24) });

  const soltos = await soltarAdiadosDaSessao(pool, {
    organizationId: ORG,
    channelSessionId: SESSAO,
    agora: AS_22H11,
  });

  expect(soltos).toBe(1);
  const update = chamadas.find((s) => s.includes('update job_queue'));
  expect(update, 'a reavaliação tem de existir — sem ela o job dorme até o horário velho').toBeTruthy();
  expect(update).toContain('run_after = now()');
  expect(update).toContain("status = 'pending'");
  expect(update).toContain('run_after > now()');
  expect(update).toContain('held_run_after');
  expect(update).toContain('adiado_por_janela');
  expect(update).toContain("payload ->> 'channel_session_id'");
  // Idempotência: a reavaliação REAGE a uma linha, nunca cria um turno novo —
  // é o insert que faria o mesmo turno disparar duas vezes.
  expect(update).not.toContain('insert');
  // A leitura dos knobs vem ANTES de qualquer escrita.
  expect(chamadas.findIndex((s) => s.includes('k.resposta_start_hour'))).toBeLessThan(chamadas.indexOf(update as string));
});

it('cenário B: com a janela 7h–22h fechada às 22h11 o PUT não mexe em ninguém', async () => {
  const { pool, chamadas } = poolFalso({ row: knobsRow(7, 22) });

  const soltos = await soltarAdiadosDaSessao(pool, {
    organizationId: ORG,
    channelSessionId: SESSAO,
    agora: AS_22H11,
  });

  expect(soltos).toBe(0);
  expect(chamadas.some((s) => s.includes('update job_queue')), 'janela fechada = adiamento de hoje continua').toBe(
    false,
  );
});

it('a reavaliação falha FECHADA: sem leitura de knobs não há update (o PUT não pode quebrar por isto)', async () => {
  const { pool, chamadas } = poolFalso({ leituraFalha: true });

  const soltos = await soltarAdiadosDaSessao(pool, {
    organizationId: ORG,
    channelSessionId: SESSAO,
    agora: AS_22H11,
    log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as never,
  });

  expect(soltos).toBe(0);
  expect(chamadas.some((s) => s.includes('update job_queue'))).toBe(false);
});

// ── O acordar pelo drain ───────────────────────────────────────────────────

it('soltarAdiadoPelaJanela mexe só em pendente FUTURO com o rastro — o MESMO turno nunca arma duas vezes', async () => {
  const { pool, chamadas } = poolFalso();

  const acordado = await soltarAdiadoPelaJanela(pool, 'job-1');

  expect(acordado).toBe(true);
  const update = chamadas.find((s) => s.includes('update job_queue'));
  expect(update).toContain('where id = $1');
  expect(update, 'um job que já rodou (running) não pode voltar para a frente').toContain("status = 'pending'");
  expect(update, 'já acordado = sem efeito: a segunda chamada não acha nada').toContain('run_after > now()');
  expect(update).toContain('held_run_after');
  expect(update).toContain('adiado_por_janela');
  expect(update, 'acordar é reagendar, nunca enfileirar de novo').not.toContain('insert');
});

it('sem linhas pendentes o acordar devolve false — nada aconteceu duas vezes', async () => {
  const chamadas: string[] = [];
  const pool = {
    query: vi.fn().mockImplementation((sql: string) => {
      chamadas.push(sql);
      return { rows: [], rowCount: 0 };
    }),
  } as unknown as pg.Pool;

  expect(await soltarAdiadoPelaJanela(pool, 'job-1')).toBe(false);
  expect(chamadas).toHaveLength(1);
});
