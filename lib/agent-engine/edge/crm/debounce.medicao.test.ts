/**
 * Medição do pior caso da janela de rajada — contato falante, teto da janela.
 *
 * A issue #1390 pede o número: "hoje cada mensagem empurra o `run_after` para
 * frente, e ninguém mediu o pior caso com contato falante". O que a medição
 * mostra (e o `decidirRajada` de verdade, com fila falsa fazendo o papel do
 * banco):
 *
 *   - a janela é ANCORADA no job que a abriu — nada aqui empurra `run_after`
 *     para frente; quem não está dentro dela abre janela nova;
 *   - por isso a espera de uma mensagem não cresce com o tamanho da rajada: com
 *     a lane livre, o teto é `debounceMs` + a espera do próximo tick de claim;
 *   - o teto real é a LANE: enquanto o turno anterior está rodando, o job novo
 *     não pode ser claimado (o claim não abre dois jobs do mesmo contato), e a
 *     espera da mensagem vira `turno + debounceMs`. É este o número que a
 *     decisão de knob precisa olhar.
 *
 * Determinístico de propósito: relógio fixo, fila falsa, nada de timer real.
 */
import { expect, it, vi } from 'vitest';
import type pg from 'pg';

import { decidirRajada } from './debounce';

const alvo = { organizationId: 'org1', contactId: 'contato1' };
const T0 = 1_700_000_000_000;

interface JobNaFila {
  id: string;
  status: 'pending' | 'running' | 'done';
  runAfter: number;
  held: boolean;
  claimedEm: number;
  terminaEm: number;
  mensagens: number;
}

interface Cenario {
  debounceMs: number;
  intervaloDePollMs: number;
  cadenciaMs: number;
  turnoMs: number;
  quantasMensagens: number;
}

interface Resumo {
  turnos: number;
  mensagens: number;
  maiorEsperaMs: number;
  mediaEsperaMs: number;
  maiorLote: number;
}

/** Relógio do cenário: mensagens numa cadência fixa, claim no tick do drain. */
async function simular(c: Cenario): Promise<Resumo> {
  const fila: JobNaFila[] = [];
  const chegadas: { jobId: string; em: number }[] = [];
  let agora = T0;
  let proximoId = 1;

  const pool = {
    query: vi.fn().mockImplementation((sql: string, params: unknown[]) => {
      if (!sql.includes('select id from job_queue')) throw new Error(`consulta inesperada: ${sql}`);
      if (String(params[1]) !== alvo.contactId) throw new Error('consulta de carona no contato errado');
      const job = fila.find(
        (j) => j.status === 'pending' && j.runAfter > agora && !j.held,
      );
      return { rows: job === undefined ? [] : [{ id: job.id }] };
    }),
  } as unknown as pg.Pool;

  /** Tick do drain: fecha o que terminou e claima a lane que está livre. */
  const tick = (): void => {
    for (const j of fila) {
      if (j.status === 'running' && j.terminaEm <= agora) j.status = 'done';
    }
    for (const j of fila) {
      if (j.status !== 'pending' || j.runAfter > agora) continue;
      if (fila.some((o) => o.status === 'running')) continue;
      j.status = 'running';
      j.claimedEm = agora;
      j.terminaEm = agora + c.turnoMs;
    }
  };

  const mensagensEm = new Set(
    Array.from({ length: c.quantasMensagens }, (_, i) => T0 + i * c.cadenciaMs),
  );
  const fimDoHorizonte =
    T0 + c.quantasMensagens * c.cadenciaMs + c.turnoMs * (c.quantasMensagens + 1) + c.debounceMs * 2;
  const tempos = new Set<number>();
  for (let t = T0; t <= fimDoHorizonte; t += c.intervaloDePollMs) tempos.add(t);
  for (const t of mensagensEm) tempos.add(t);

  for (const t of [...tempos].sort((a, b) => a - b)) {
    agora = t;
    tick();
    if (!mensagensEm.has(t)) continue;
    const decisao = await decidirRajada(pool, alvo, c.debounceMs, agora);
    if (decisao.tipo === 'coalescido') {
      const job = fila.find((j) => j.id === decisao.jobId);
      if (job === undefined) throw new Error('carona em job que não existe');
      job.mensagens += 1;
      chegadas.push({ jobId: job.id, em: agora });
    } else {
      const job: JobNaFila = {
        id: `job-${proximoId++}`,
        status: 'pending',
        runAfter: decisao.runAfter?.getTime() ?? agora,
        held: false,
        claimedEm: 0,
        terminaEm: 0,
        mensagens: 1,
      };
      fila.push(job);
      chegadas.push({ jobId: job.id, em: agora });
    }
  }

  // Esvazia a fila no relógio do cenário — nenhuma espera fica de fora.
  while (fila.some((j) => j.status !== 'done')) {
    agora += c.intervaloDePollMs;
    tick();
  }

  const esperas = chegadas.map((m) => {
    const job = fila.find((j) => j.id === m.jobId);
    if (job === undefined) throw new Error('mensagem sem job');
    return job.claimedEm - m.em;
  });

  return {
    turnos: fila.length,
    mensagens: chegadas.length,
    maiorEsperaMs: Math.max(...esperas),
    mediaEsperaMs: Math.round(esperas.reduce((soma, e) => soma + e, 0) / esperas.length),
    maiorLote: Math.max(...fila.map((j) => j.mensagens)),
  };
}

/** Contato falante: uma mensagem a cada segundo, janela de 2s, poll de 1s. */
const base = { debounceMs: 2_000, intervaloDePollMs: 1_000, cadenciaMs: 1_000, quantasMensagens: 24 };

it('mede a rajada com turno curto: o teto é a janela mais o tick de claim', async () => {
  const resumo = await simular({ ...base, turnoMs: 1_500 });
  // Medido: turno curto não segura a lane, então quem manda é a janela — 24
  // mensagens viram 12 turnos de 2 mensagens, e a espera máxima é 2× o tick.
  expect(resumo).toEqual({
    turnos: 12,
    mensagens: 24,
    maiorEsperaMs: 2_000,
    mediaEsperaMs: 1_500,
    maiorLote: 2,
  });
  expect(resumo.maiorLote).toBe(base.debounceMs / base.cadenciaMs); // a 3ª chega quando a janela já venceu e o job é claimável
  expect(resumo.maiorEsperaMs).toBeLessThanOrEqual(base.debounceMs + base.intervaloDePollMs);
});

it('mede a rajada com turno longo: a espera deixa de ser a janela e passa a ser a fila da lane', async () => {
  const resumo = await simular({ ...base, turnoMs: 12_000 });
  // Medido: com o turno (12s) segurando a lane, o job novo não é claimado e a
  // espera cresce com a fila — 112s para a última mensagem da rajada. O teto
  // não é o debounce; é a duração do turno × fila na frente.
  expect(resumo).toEqual({
    turnos: 12,
    mensagens: 24,
    maiorEsperaMs: 112_000,
    mediaEsperaMs: 56_500,
    maiorLote: 2,
  });
  expect(resumo.maiorEsperaMs).toBeGreaterThan(base.debounceMs * 10);
});

it('mede a rajada apertada: a janela junta o lote inteiro num turno só', async () => {
  const resumo = await simular({
    debounceMs: 2_000,
    intervaloDePollMs: 1_000,
    cadenciaMs: 200,
    turnoMs: 3_000,
    quantasMensagens: 12,
  });
  // Medido: 12 mensagens em 2,2s viram 2 turnos — o primeiro leva 10 mensagens.
  // É para isto que a janela existe: sem ela seriam 12 turnos, 12 respostas e
  // 12× o custo de LLM para a mesma conversa.
  expect(resumo).toEqual({
    turnos: 2,
    mensagens: 12,
    maiorEsperaMs: 3_000,
    mediaEsperaMs: 1_400,
    maiorLote: 10,
  });
  expect(resumo.maiorLote).toBeGreaterThan(resumo.mensagens / 2);
});
