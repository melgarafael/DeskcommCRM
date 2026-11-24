/**
 * Medição do pior caso da janela de rajada — contato falante, teto da janela.
 *
 * A issue #1390 pede o número: "hoje cada mensagem empurra o `run_after` para
 * frente, e ninguém mediu o pior caso com contato falante". O que a medição
 * mostra (e o `decidirRajada` de verdade, com fila falsa fazendo o papel do
 * banco):
 *
 *   - a janela ANDA a cada mensagem de carona e PARA no teto (`tetoMs`, issue
 *     #196): com `tetoMs = debounceMs` o cenário reproduz a janela ANCORADA que
 *     existia antes, e os números daqueles casos continuam servindo de linha de
 *     base;
 *   - com a lane livre, a espera de uma mensagem não cresce com a rajada: o
 *     teto é `debounceMs` + a espera do próximo tick de claim;
 *   - com a lane ocupada, o teto real é a LANE: o job novo não pode ser claimado
 *     (o claim não abre dois jobs do mesmo contato), e a espera da mensagem vira
 *     `turno + debounceMs` — é este o número que a decisão de knob precisa
 *     olhar;
 *   - o teto da rajada limita quantas mensagens cabem num lote e, por
 *     consequência, quantos turnos a conversa contínua custa.
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
  /** `created_at` — âncora do teto da rajada (#196). */
  createdAt: number;
  runAfter: number;
  held: boolean;
  claimedEm: number;
  terminaEm: number;
  mensagens: number;
}

interface Cenario {
  debounceMs: number;
  /**
   * Teto da rajada deslizante (#196). `tetoMs = debounceMs` reproduz o
   * comportamento ANCORADO de antes (o `run_after` nasce e não anda).
   */
  tetoMs: number;
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
      if (sql.includes('update job_queue set run_after')) {
        const job = fila.find((j) => j.id === params[0]);
        if (job !== undefined && job.status === 'pending') job.runAfter = Date.parse(String(params[1]));
        return { rows: [] };
      }
      if (!sql.includes('select id, payload, created_at, run_after from job_queue')) {
        throw new Error(`consulta inesperada: ${sql}`);
      }
      if (String(params[1]) !== alvo.contactId) throw new Error('consulta de carona no contato errado');
      // As duas portas do predicado real — lidas do SQL, para a simulação não
      // ser mais generosa que a consulta de produção (#196).
      const teto = Number(params[2]);
      const portaDaJanela = sql.includes('run_after > now()');
      const portaDoTeto = sql.includes('created_at +');
      const job = fila.find(
        (j) =>
          j.status === 'pending' &&
          !j.held &&
          ((portaDaJanela && j.runAfter > agora) || (portaDoTeto && j.createdAt + teto > agora)),
      );
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
    T0 +
    c.quantasMensagens * c.cadenciaMs +
    c.turnoMs * (c.quantasMensagens + 1) +
    Math.max(c.debounceMs, c.tetoMs) * 2;
  const tempos = new Set<number>();
  for (let t = T0; t <= fimDoHorizonte; t += c.intervaloDePollMs) tempos.add(t);
  for (const t of mensagensEm) tempos.add(t);

  for (const t of [...tempos].sort((a, b) => a - b)) {
    agora = t;
    tick();
    if (!mensagensEm.has(t)) continue;
    const decisao = await decidirRajada(pool, alvo, c.debounceMs, agora, undefined, c.tetoMs);
    if (decisao.tipo === 'coalescido') {
      const job = fila.find((j) => j.id === decisao.jobId);
      if (job === undefined) throw new Error('carona em job que não existe');
      job.mensagens += 1;
      chegadas.push({ jobId: job.id, em: agora });
    } else {
      const job: JobNaFila = {
        id: `job-${proximoId++}`,
        status: 'pending',
        createdAt: agora,
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
// `tetoMs = debounceMs` = janela ANCORADA: é a linha de base de antes do #196.
const base = {
  debounceMs: 2_000,
  tetoMs: 2_000,
  intervaloDePollMs: 1_000,
  cadenciaMs: 1_000,
  quantasMensagens: 24,
};

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
    tetoMs: 2_000,
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
// ── #196: a rajada DESLIZANTE, medida com bolhas de 6s e turno de 30s ──────
/**
 * O caso da issue, em escala: bolhas humanas de 6s, janela de 2s (proporção
 * 3×, a mesma de 24s de bolha para 8s de `INBOUND_DEBOUNCE_MS`) e turno de 30s
 * segurando a lane — que é o que faz o job da primeira bolha continuar PENDENTE
 * enquanto as seguintes chegam, a única situação em que a carona é possível.
 */
const rajadaHumana = {
  debounceMs: 2_000,
  intervaloDePollMs: 1_000,
  cadenciaMs: 6_000,
  turnoMs: 30_000,
  quantasMensagens: 8,
};

it('mede a rajada humana com a janela ANCORADA (antes do #196): oito bolhas, OITO turnos', async () => {
  const resumo = await simular({ ...rajadaHumana, tetoMs: 2_000 });
  // Medido: nenhuma bolha pega carona (`maiorLote: 1`), porque o `run_after` da
  // primeira vence em 2s e a segunda chega em 6s. Oito turnos, e como cada um
  // segura a lane por 30s, a última bolha espera 170s para ser atendida — é o
  // "IA respondendo em duplicidade" que o dono vê, com o agravante de a fila
  // empurrar a resposta para quase três minutos.
  expect(resumo).toEqual({
    turnos: 8,
    mensagens: 8,
    maiorEsperaMs: 170_000,
    mediaEsperaMs: 86_000,
    maiorLote: 1,
  });
});

it('mede a MESMA rajada com a janela DESLIZANTE (teto de 18s): metade dos turnos, lote de 3', async () => {
  const resumo = await simular({ ...rajadaHumana, tetoMs: 18_000 });
  // Medido: as bolhas que chegam enquanto o job anterior ainda está pendente
  // (lane de 30s) viajam de carona — 8 mensagens em 4 turnos, lote de até 3, e
  // a espera da última cai de 170s para 50s (menos gente na frente na lane).
  // Não são 1 turno porque, passados os 18s do teto, a bolha seguinte abre
  // rajada nova — que é o limite que a issue pede para existir.
  expect(resumo).toEqual({
    turnos: 4,
    mensagens: 8,
    maiorEsperaMs: 50_000,
    mediaEsperaMs: 26_000,
    maiorLote: 3,
  });
  expect(resumo.turnos).toBeLessThan(rajadaHumana.quantasMensagens / 2 + 1);
  expect(resumo.maiorEsperaMs).toBeLessThan(170_000 / 3);
});
