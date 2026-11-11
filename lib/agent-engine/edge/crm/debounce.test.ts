import { expect, it, vi } from 'vitest';
import type pg from 'pg';

import { decidirRajada, janelaDeRajada, debounceEfetivo, TETO_DEBOUNCE_MS } from './debounce';

const alvo = { organizationId: 'org1', contactId: 'contato1' };
/** Instante fixo: a janela é aritmética e o teste não depende do relógio. */
const AGORA = 1_700_000_000_000;

/** Pool falso no padrão do `drain.test.ts`: responde por leitura do SQL. */
function poolFalso(
  resposta: (sql: string) => { id: string; payload?: unknown }[],
  chamadas: string[] = [],
): pg.Pool {
  const query = vi.fn().mockImplementation((sql: string) => {
    chamadas.push(sql);
    return { rows: resposta(sql) };
  });
  return { query } as unknown as pg.Pool;
}

it('mensagem dentro da janela viaja de carona no job pendente — sem abrir turno novo', async () => {
  const chamadas: string[] = [];
  const pool = poolFalso(() => [{ id: 'job-pendente' }], chamadas);

  const decisao = await decidirRajada(pool, alvo, 500, AGORA);

  expect(decisao).toEqual({ tipo: 'coalescido', jobId: 'job-pendente' });
  expect(chamadas).toHaveLength(1);
  expect(chamadas[0]).toContain("kind = 'inbound_turn'");
});

it('sem job futuro: a janela abre em agora + debounceMs', async () => {
  const pool = poolFalso(() => []);

  const decisao = await decidirRajada(pool, alvo, 500, AGORA);

  expect(decisao).toEqual({ tipo: 'enfileirar', runAfter: new Date(AGORA + 500) });
});

it('debounce 0 desliga a coalescência: job imediato e nenhuma consulta', async () => {
  const chamadas: string[] = [];
  const pool = poolFalso(() => [{ id: 'nao-deveria-ser-lido' }], chamadas);

  const decisao = await decidirRajada(pool, alvo, 0, AGORA);

  expect(decisao).toStrictEqual({ tipo: 'enfileirar', runAfter: undefined });
  expect(chamadas).toHaveLength(0);
});

/**
 * A lição do #830 fica presa na consulta: job em HOLD não recebe carona.
 *
 * `enforceHolds` (session-watchdog.ts) marca hold com `run_after = 'infinity'`,
 * que É maior que `now()` — então a consulta sem a exclusão devolve um job que
 * nunca vai rodar, e toda mensagem nova do contato coagula nele para sempre
 * (medido em produção: 6 mensagens em 7h, zero resposta).
 *
 * O pool falso abaixo faz o papel do banco: devolve o job em hold SE a consulta
 * não o excluir. Tirar o predicado do SQL deixa este teste vermelho.
 */
it('job em hold não recebe carona — a consulta precisa excluir held_run_after', async () => {
  const chamadas: string[] = [];
  const pool = poolFalso((sql) => (sql.includes('held_run_after') ? [] : [{ id: 'job-em-hold' }]), chamadas);

  const decisao = await decidirRajada(pool, alvo, 500, AGORA);

  expect(chamadas[0]).toContain('held_run_after');
  expect(decisao).toEqual({ tipo: 'enfileirar', runAfter: new Date(AGORA + 500) });
});

// ── #3383: a carona não pode engolir mensagem numa janela que já abriu ─────
const ABRIDO_PELA_JANELA = {
  adiado_por_janela: { tipo: 'resposta', abertura: '2026-07-28T10:00:00.000Z', janela: '7h-22h' },
};

it('cenário A: janela de resposta ABERTA — o job adiado não recebe carona e é apontado para acordar', async () => {
  const pool = poolFalso(() => [{ id: 'job-adiado', payload: ABRIDO_PELA_JANELA }]);

  const decisao = await decidirRajada(pool, alvo, 500, AGORA, async () => true);

  // A mensagem nova NÃO entra no job que ainda dorme até o horário antigo…
  expect(decisao).toEqual({
    tipo: 'enfileirar',
    runAfter: new Date(AGORA + 500),
    caronaRecusadaEm: 'job-adiado',
  });
  // …e o adiado é devolvido para quem acorda — ele não pode continuar esperando.
  expect((decisao as { caronaRecusadaEm?: string }).caronaRecusadaEm).toBe('job-adiado');
});

it('cenário B: janela FECHADA — o adiado segue esperando e a mensagem viaja de carona (regressão zero)', async () => {
  const pool = poolFalso(() => [{ id: 'job-adiado', payload: ABRIDO_PELA_JANELA }]);

  const decisao = await decidirRajada(pool, alvo, 500, AGORA, async () => false);

  expect(decisao).toEqual({ tipo: 'coalescido', jobId: 'job-adiado' });
});

it('job de debounce (sem o rastro) continua recebendo carona mesmo com a janela aberta', async () => {
  const pool = poolFalso(() => [{ id: 'job-de-debounce', payload: { conversation_id: 'c1' } }]);

  const decisao = await decidirRajada(pool, alvo, 500, AGORA, async () => true);

  // Abrir a janela não pode desmontar a coalescência normal de 8 s.
  expect(decisao).toEqual({ tipo: 'coalescido', jobId: 'job-de-debounce' });
});

it('adiado pela janela de DISPARO (retomada) não muda a coalescência da resposta', async () => {
  const pool = poolFalso(() => [
    {
      id: 'job-de-retomada',
      payload: { adiado_por_janela: { tipo: 'disparo', abertura: '2026-07-28T10:00:00.000Z', janela: '7h-22h' } },
    },
  ]);

  const decisao = await decidirRajada(pool, alvo, 500, AGORA, async () => true);

  expect(decisao).toEqual({ tipo: 'coalescido', jobId: 'job-de-retomada' });
});

it('sem o quinto argumento (chamador antigo) nada muda — candidato adiado ainda coalesce', async () => {
  const pool = poolFalso(() => [{ id: 'job-adiado', payload: ABRIDO_PELA_JANELA }]);

  const decisao = await decidirRajada(pool, alvo, 500, AGORA);

  expect(decisao).toEqual({ tipo: 'coalescido', jobId: 'job-adiado' });
});

it('janelaDeRajada: sem debounce não há janela; com debounce a janela é agora + janela', () => {
  expect(janelaDeRajada(0, AGORA)).toBeUndefined();
  expect(janelaDeRajada(750, AGORA)?.getTime()).toBe(AGORA + 750);
});

// ── Leitor de debounce configurável por agente (issue #1856) ────────────
const ENV = 8_000;

it('debounceEfetivo: campo vazio (null) usa o default da instalação — regressão zero', () => {
  expect(debounceEfetivo(null, ENV)).toBe(ENV);
  expect(debounceEfetivo(undefined, ENV)).toBe(ENV);
});

it('debounceEfetivo: campo preenchido vence o default', () => {
  expect(debounceEfetivo(20_000, ENV)).toBe(20_000);
});

it('debounceEfetivo: 0 desliga a coalescência — não herda nem clampa', () => {
  expect(debounceEfetivo(0, ENV)).toBe(0);
});

it('debounceEfetivo: teto de 60s — valor ACIMA do teto é clamado no limite', () => {
  expect(TETO_DEBOUNCE_MS).toBe(60_000);
  expect(debounceEfetivo(60_000, ENV)).toBe(60_000);
  expect(debounceEfetivo(90_000, ENV)).toBe(60_000);
});

it('debounceEfetivo: valor NEGATIVO (dado sujo) clampa para 0, não quebra', () => {
  expect(debounceEfetivo(-5, ENV)).toBe(0);
});
