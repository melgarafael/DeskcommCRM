import { expect, it, vi } from 'vitest';
import type pg from 'pg';

import { loadEnv } from '../../env';

import { decidirRajada, janelaDeRajada, debounceEfetivo, tetoDaRajada, TETO_DEBOUNCE_MS } from './debounce';

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

  expect(decisao).toEqual({ tipo: 'coalescido', jobId: 'job-pendente', janelaEstendidaAte: null });
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

  expect(decisao).toEqual({ tipo: 'coalescido', jobId: 'job-adiado', janelaEstendidaAte: null });
});

it('job de debounce (sem o rastro) continua recebendo carona mesmo com a janela aberta', async () => {
  const pool = poolFalso(() => [{ id: 'job-de-debounce', payload: { conversation_id: 'c1' } }]);

  const decisao = await decidirRajada(pool, alvo, 500, AGORA, async () => true);

  // Abrir a janela não pode desmontar a coalescência normal de 8 s.
  expect(decisao).toEqual({ tipo: 'coalescido', jobId: 'job-de-debounce', janelaEstendidaAte: null });
});

it('adiado pela janela de DISPARO (retomada) não muda a coalescência da resposta', async () => {
  const pool = poolFalso(() => [
    {
      id: 'job-de-retomada',
      payload: { adiado_por_janela: { tipo: 'disparo', abertura: '2026-07-28T10:00:00.000Z', janela: '7h-22h' } },
    },
  ]);

  const decisao = await decidirRajada(pool, alvo, 500, AGORA, async () => true);

  expect(decisao).toEqual({ tipo: 'coalescido', jobId: 'job-de-retomada', janelaEstendidaAte: null });
});

it('sem o quinto argumento (chamador antigo) nada muda — candidato adiado ainda coalesce', async () => {
  const pool = poolFalso(() => [{ id: 'job-adiado', payload: ABRIDO_PELA_JANELA }]);

  const decisao = await decidirRajada(pool, alvo, 500, AGORA);

  expect(decisao).toEqual({ tipo: 'coalescido', jobId: 'job-adiado', janelaEstendidaAte: null });
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
// ── #196 (b): a janela ANDA e para no teto ────────────────────────────────
/**
 * Dublê que distingue as duas consultas do módulo e guarda os parâmetros —
 * é nos parâmetros do UPDATE que se vê para onde a janela foi.
 */
function poolComJanela(
  candidato: { id: string; criadoEm?: number; runAfterEm?: number; payload?: unknown },
  opcoes: { updateFalha?: string } = {},
): { pool: pg.Pool; updates: unknown[][] } {
  const updates: unknown[][] = [];
  const query = vi.fn().mockImplementation((sql: string, params: unknown[] = []) => {
    if (sql.includes('select id, payload, created_at, run_after from job_queue')) {
      return {
        rows: [
          {
            id: candidato.id,
            payload: candidato.payload ?? {},
            created_at: candidato.criadoEm === undefined ? null : new Date(candidato.criadoEm),
            run_after: candidato.runAfterEm === undefined ? null : new Date(candidato.runAfterEm),
          },
        ],
      };
    }
    if (sql.includes('update job_queue set run_after')) {
      updates.push(params);
      if (opcoes.updateFalha !== undefined) throw new Error(opcoes.updateFalha);
      return { rows: [] };
    }
    throw new Error(`consulta inesperada: ${sql}`);
  });
  return { pool: { query } as unknown as pg.Pool, updates };
}

it('a mensagem de carona EMPURRA a janela: run_after = agora + debounce, preso ao teto', async () => {
  const { pool, updates } = poolComJanela({
    id: 'job-rajada',
    criadoEm: AGORA,
    runAfterEm: AGORA + 8_000,
  });

  const decisao = await decidirRajada(pool, alvo, 8_000, AGORA + 12_100, undefined, 45_000);

  expect(decisao).toEqual({
    tipo: 'coalescido',
    jobId: 'job-rajada',
    janelaEstendidaAte: new Date(AGORA + 20_100),
  });
  expect(updates, 'uma escrita, e ela é do job da rajada').toEqual([
    ['job-rajada', new Date(AGORA + 20_100).toISOString(), alvo.organizationId],
  ]);
});

it('no TETO a janela para de andar — nenhum UPDATE depois de created_at + teto', async () => {
  const { pool, updates } = poolComJanela({
    id: 'job-rajada',
    criadoEm: AGORA,
    runAfterEm: AGORA + 45_000, // já encostado no teto
  });

  const decisao = await decidirRajada(pool, alvo, 8_000, AGORA + 44_000, undefined, 45_000);

  expect(decisao).toEqual({ tipo: 'coalescido', jobId: 'job-rajada', janelaEstendidaAte: null });
  expect(updates, 'escrever o mesmo horário seria UPDATE de graça a cada bolha').toHaveLength(0);
});

it('job adiado pela JANELA DE RESPOSTA nunca é ENCURTADO pela rajada', async () => {
  // `run_after` às 07:00 (a janela de resposta), `created_at` de agora: a conta
  // da rajada daria agora+8s, ou seja ADIANTARIA uma resposta combinada.
  const amanha = AGORA + 12 * 60 * 60 * 1000;
  const { pool, updates } = poolComJanela({ id: 'job-adiado', criadoEm: AGORA, runAfterEm: amanha });

  const decisao = await decidirRajada(pool, alvo, 8_000, AGORA, undefined, 45_000);

  expect(decisao).toEqual({ tipo: 'coalescido', jobId: 'job-adiado', janelaEstendidaAte: null });
  expect(updates).toHaveLength(0);
});

it('falha no UPDATE não derruba a carona: devolve erroAoEstender e a mensagem já está no lote', async () => {
  const { pool } = poolComJanela(
    { id: 'job-rajada', criadoEm: AGORA, runAfterEm: AGORA + 8_000 },
    { updateFalha: 'deadlock detected' },
  );

  const decisao = await decidirRajada(pool, alvo, 8_000, AGORA + 12_100, undefined, 45_000);

  expect(decisao).toEqual({
    tipo: 'coalescido',
    jobId: 'job-rajada',
    janelaEstendidaAte: null,
    erroAoEstender: 'deadlock detected',
  });
});

/**
 * O default da instalação é parte da PROPOSTA do #196 e fica preso aqui: 45s
 * (§ `INBOUND_BURST_MAX_MS` em `lib/agent-engine/env.ts` tem a justificativa —
 * 29,6s medidos na issue, com margem). Se o valor mudar, muda com decisão.
 */
it('INBOUND_BURST_MAX_MS: 45s por default, e nunca abaixo da janela de debounce', () => {
  // Só as três chaves que o schema exige; nenhuma delas entra nesta conta.
  //
  // O nome do banco é NEUTRO de propósito (`/db`, como em `lib/agent-engine/env.test.ts`):
  // a catraca de marca (`tests/unit/branding.test.ts`) varre `lib/` inteiro, `.ts`
  // inclusive, e reprova o nome do produto hardcoded em arquivo fora de
  // `MARCA_CONGELADA`. Fixture de teste não é lugar de gravar a marca.
  const env = loadEnv({
    NODE_ENV: 'test',
    SUPABASE_DB_URL: 'postgres://user:pass@127.0.0.1:5432/db',
    NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
    SUPABASE_SERVICE_ROLE_KEY: 'chave-de-teste',
  });
  expect(env.INBOUND_BURST_MAX_MS).toBe(45_000);
  expect(env.INBOUND_DEBOUNCE_MS).toBe(8_000);
  expect(tetoDaRajada(env.INBOUND_BURST_MAX_MS, env.INBOUND_DEBOUNCE_MS)).toBe(45_000);
  // Teto menor que a janela não encurta a janela (ver `tetoDaRajada`).
  expect(tetoDaRajada(1_000, 8_000)).toBe(8_000);
});
