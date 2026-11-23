/**
 * A JANELA DE RAJADA ANDA, E PARA NO TETO (issue #196, parte (b)).
 *
 * ─── O defeito, medido em produção ───────────────────────────────────────────
 *
 * `run_after = created_at + INBOUND_DEBOUNCE_MS` era fixado na criação do job e
 * nunca estendido. Rajada humana típica — bolhas de WhatsApp de 10-20s — cai
 * fora da janela de 8s: cada bolha que chega depois do `run_after` não acha nada
 * para pegar carona e abre job novo. Medido na issue: 3 mensagens do mesmo
 * contato, gaps de 12,1s e 17,5s, zero coalescência, 3 turnos, 3 respostas
 * separadas no mesmo assunto — "a IA respondendo em duplicidade" do lado do
 * dono, e o gatilho de ban que o debounce existe para evitar.
 *
 * ─── O conserto ──────────────────────────────────────────────────────────────
 *
 * (1) o job da rajada continua sendo CANDIDATO enquanto `created_at + teto >
 *     now()`, mesmo depois de o `run_after` original ter vencido;
 * (2) ao receber a carona, o `run_after` é EMPURRADO para `agora + debounce`;
 * (3) o empurrão para no teto (`created_at + teto`), então rajada sem fim produz
 *     uma resposta a cada teto em vez de adiar para sempre.
 *
 * ─── Por que este teste reprova com o código antigo ──────────────────────────
 *
 * O banco de mentira implementa exatamente as duas consultas reais — o SELECT de
 * carona (com as duas portas do predicado) e o UPDATE da janela — e o relógio é
 * o do cenário, nunca o de parede: cada mensagem é um instante fixo, sem timer
 * real e sem `sleep`. Sem o teto (ou sem o UPDATE), o cenário de produção volta
 * a dar 3 jobs — é o primeiro caso do arquivo.
 */
import { expect, it, vi } from 'vitest';
import type pg from 'pg';

import { decidirRajada, janelaEstendidaAte, tetoDaRajada } from './debounce';

const alvo = { organizationId: 'org1', contactId: 'contato1' };
/** T0 do cenário: 1_700_000_000_000 ms — relógio de parede não entra em lugar nenhum. */
const T0 = 1_700_000_000_000;

interface JobNaFila {
  id: string;
  /** `created_at` do job — a âncora do teto. */
  createdAt: number;
  runAfter: number;
  held: boolean;
}

interface Atualizacao {
  jobId: string;
  runAfter: number;
}

/**
 * Banco de mentira com uma `job_queue` em memória. `relogio` faz o papel de
 * `now()` do Postgres: quem escreve é o teste, instante por instante.
 */
function bancoDeMentira() {
  const jobs: JobNaFila[] = [];
  const atualizacoes: Atualizacao[] = [];
  let relogio = T0;
  let sequencia = 0;

  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('select id, payload, created_at, run_after from job_queue')) {
      const teto = Number(params[2]);
      // As portas são lidas do SQL REAL: apagar uma delas da consulta deixa este
      // dublê sem a porta correspondente — é assim que o teste sente a sabotagem,
      // em vez de passar por cima dela com uma regra própria mais generosa.
      const portaDaJanela = sql.includes('run_after > now()');
      const portaDoTeto = sql.includes('created_at +');
      const candidatos = jobs
        .filter(
          (j) =>
            !j.held &&
            ((portaDaJanela && j.runAfter > relogio) ||
              (portaDoTeto && j.createdAt + teto > relogio)),
        )
        .sort((a, b) => a.createdAt - b.createdAt);
      const job = candidatos[0];
      return {
        rows:
          job === undefined
            ? []
            : [
                {
                  id: job.id,
                  payload: {},
                  created_at: new Date(job.createdAt),
                  run_after: new Date(job.runAfter),
                },
              ],
      };
    }
    if (sql.includes('update job_queue set run_after')) {
      const job = jobs.find((j) => j.id === params[0]);
      if (job !== undefined) {
        job.runAfter = Date.parse(String(params[1]));
        atualizacoes.push({ jobId: job.id, runAfter: job.runAfter });
      }
      return { rows: [] };
    }
    throw new Error(`consulta inesperada: ${sql}`);
  });

  /** Um evento de mensagem no instante `em`: carona no job da rajada ou job novo. */
  const receber = async (
    em: number,
    p: { debounceMs: number; tetoMs?: number },
  ): Promise<'carona' | 'novo'> => {
    relogio = em;
    const decisao = await decidirRajada(
      { query } as unknown as pg.Pool,
      alvo,
      p.debounceMs,
      em,
      undefined,
      p.tetoMs,
    );
    if (decisao.tipo === 'coalescido') return 'carona';
    jobs.push({
      id: `job-${++sequencia}`,
      createdAt: em,
      runAfter: decisao.runAfter?.getTime() ?? em,
      held: false,
    });
    return 'novo';
  };

  return { jobs, atualizacoes, receber, pool: { query } as unknown as pg.Pool };
}

/** Os dois gaps medidos na issue: 12,1s e 17,5s → rajada de 29,6s. */
const GAPS_DA_PRODUCAO = [12_100, 17_500] as const;
const DEBOUNCE_PADRAO = 8_000;
const TETO_PADRAO = 45_000;

it('REPRODUZ a produção: gaps de 12,1s e 17,5s sem teto dão TRÊS jobs — o defeito do #196', async () => {
  // O código de antes desta mudança, byte a byte: sem teto, a janela é ancorada
  // em `created_at + debounce` e o job nunca anda.
  const banco = bancoDeMentira();
  const chegadas = [0, GAPS_DA_PRODUCAO[0], GAPS_DA_PRODUCAO[0] + GAPS_DA_PRODUCAO[1]] as const;

  const desfechos = [];
  for (const em of chegadas) {
    desfechos.push(await banco.receber(T0 + em, { debounceMs: DEBOUNCE_PADRAO }));
  }

  expect(desfechos, 'sem janela deslizante, cada bolha abre turno próprio').toEqual([
    'novo',
    'novo',
    'novo',
  ]);
  expect(banco.jobs).toHaveLength(3);
  expect(banco.atualizacoes, 'nada empurra o run_after no código antigo').toHaveLength(0);
});

it('com o teto do #196, a MESMA rajada vira UM job — e o run_after anda a cada bolha', async () => {
  const banco = bancoDeMentira();
  const chegadas = [0, GAPS_DA_PRODUCAO[0], GAPS_DA_PRODUCAO[0] + GAPS_DA_PRODUCAO[1]] as const;

  const desfechos = [];
  for (const em of chegadas) {
    desfechos.push(await banco.receber(T0 + em, { debounceMs: DEBOUNCE_PADRAO, tetoMs: TETO_PADRAO }));
  }

  expect(desfechos, 'as três bolhas do mesmo assunto têm de virar um turno').toEqual([
    'novo',
    'carona',
    'carona',
  ]);
  expect(banco.jobs).toHaveLength(1);

  // 2ª bolha em T0+12,1s: janela vai para T0+20,1s (12,1 + 8).
  // 3ª bolha em T0+29,6s: janela vai para T0+37,6s — ainda dentro do teto (45s).
  expect(banco.atualizacoes).toEqual([
    { jobId: 'job-1', runAfter: T0 + 12_100 + DEBOUNCE_PADRAO },
    { jobId: 'job-1', runAfter: T0 + 29_600 + DEBOUNCE_PADRAO },
  ]);
  expect(banco.jobs[0]!.runAfter).toBe(T0 + 37_600);
});

it('o teto é o que separa "rajada" de "conversa sem fim": o contato que não para abre turno novo no teto', async () => {
  // Uma bolha a cada 5s, de T0 a T0+70s. Sem teto seria um job só, adiado para
  // sempre — e o cliente sem resposta. Com teto de 45s, o primeiro job para
  // exatamente em T0+45s e a bolha seguinte abre rajada nova.
  const banco = bancoDeMentira();
  const chegadas: number[] = [];
  for (let em = 0; em <= 70_000; em += 5_000) chegadas.push(em);

  for (const em of chegadas) {
    await banco.receber(T0 + em, { debounceMs: DEBOUNCE_PADRAO, tetoMs: TETO_PADRAO });
  }

  const [primeiro, segundo] = banco.jobs;
  expect(banco.jobs.length, 'dois turnos em 70s de conversa contínua, não um por bolha').toBe(2);
  expect(primeiro?.createdAt).toBe(T0);
  expect(
    primeiro?.runAfter,
    'o run_after do primeiro job encosta no teto e NÃO passa dele',
  ).toBe(T0 + TETO_PADRAO);
  if (primeiro === undefined || segundo === undefined) throw new Error('faltou job no cenário');
  // A bolha de T0+45s já cai FORA do teto (`created_at + teto > now()` é estrito):
  // abre o segundo job, que conta o próprio teto a partir daí.
  expect(segundo.createdAt).toBe(T0 + 45_000);
  expect(segundo.runAfter, 'o segundo job anda normalmente dentro do próprio teto').toBe(
    T0 + 70_000 + DEBOUNCE_PADRAO,
  );
  const doPrimeiro = banco.atualizacoes.filter((a) => a.jobId === primeiro.id);
  expect(doPrimeiro.length, 'o primeiro job foi empurrado até o teto, e parou').toBeGreaterThan(1);
  expect(
    Math.max(...doPrimeiro.map((a) => a.runAfter)),
    'a última janela do primeiro job fica em T0+45s: passar daí é adiar sem fim',
  ).toBe(T0 + TETO_PADRAO);
});

it('teto de 30s cobre a rajada medida por 0,4s de margem; teto de 25s já a parte em dois', async () => {
  const chegadas = [0, GAPS_DA_PRODUCAO[0], GAPS_DA_PRODUCAO[0] + GAPS_DA_PRODUCAO[1]] as const;

  const comTrinta = bancoDeMentira();
  for (const em of chegadas) {
    await comTrinta.receber(T0 + em, { debounceMs: DEBOUNCE_PADRAO, tetoMs: 30_000 });
  }
  expect(comTrinta.jobs, '29,6s < 30s: as três cabem — por 400ms').toHaveLength(1);
  expect(comTrinta.jobs[0]!.runAfter, 'e a janela é cortada no teto, não em 37,6s').toBe(T0 + 30_000);

  const comVinteECinco = bancoDeMentira();
  for (const em of chegadas) {
    await comVinteECinco.receber(T0 + em, { debounceMs: DEBOUNCE_PADRAO, tetoMs: 25_000 });
  }
  expect(comVinteECinco.jobs, 'a terceira bolha fica fora: 29,6s > 25s').toHaveLength(2);
});

it('sem teto (ou com teto 0) o comportamento é o ANCORADO de antes — nenhum chamador antigo muda', async () => {
  for (const tetoMs of [undefined, 0]) {
    const banco = bancoDeMentira();
    await banco.receber(T0, { debounceMs: DEBOUNCE_PADRAO, tetoMs });
    await banco.receber(T0 + 12_100, { debounceMs: DEBOUNCE_PADRAO, tetoMs });
    expect(banco.jobs, `teto=${String(tetoMs)}: janela ancorada`).toHaveLength(2);
    expect(banco.atualizacoes).toHaveLength(0);
  }
});

it('tetoDaRajada: teto menor que a janela vale a janela; 0/ausente é o opt-out ancorado', () => {
  expect(tetoDaRajada(undefined, 8_000)).toBe(8_000);
  expect(tetoDaRajada(0, 8_000)).toBe(8_000);
  expect(tetoDaRajada(45_000, 8_000)).toBe(45_000);
  // Agente com janela de 60s (teto do #1856) e teto global de 45s: manda a
  // janela, senão o teto venceria antes de o job nascer claimável.
  expect(tetoDaRajada(45_000, 60_000)).toBe(60_000);
  // Sem debounce não há rajada nenhuma para limitar.
  expect(tetoDaRajada(45_000, 0)).toBe(0);
});

it('janelaEstendidaAte: agora + debounce, nunca além do teto contado da âncora', () => {
  expect(janelaEstendidaAte(T0, 45_000, 8_000, T0 + 12_100)).toBe(T0 + 20_100);
  // Última bolha colada no teto: o mínimo é a âncora.
  expect(janelaEstendidaAte(T0, 45_000, 8_000, T0 + 44_000)).toBe(T0 + 45_000);
  // Depois do teto o candidato nem existe; se a conta rodasse, pararia no teto.
  expect(janelaEstendidaAte(T0, 45_000, 8_000, T0 + 90_000)).toBe(T0 + 45_000);
});
