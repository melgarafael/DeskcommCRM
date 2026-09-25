import { expect, it, vi } from 'vitest';
import type pg from 'pg';

import { decidirRajada, janelaDeRajada } from './debounce';

const alvo = { organizationId: 'org1', contactId: 'contato1' };
/** Instante fixo: a janela é aritmética e o teste não depende do relógio. */
const AGORA = 1_700_000_000_000;

/** Pool falso no padrão do `drain.test.ts`: responde por leitura do SQL. */
function poolFalso(resposta: (sql: string) => { id: string }[], chamadas: string[] = []): pg.Pool {
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

it('janelaDeRajada: sem debounce não há janela; com debounce a janela é agora + janela', () => {
  expect(janelaDeRajada(0, AGORA)).toBeUndefined();
  expect(janelaDeRajada(750, AGORA)?.getTime()).toBe(AGORA + 750);
});
