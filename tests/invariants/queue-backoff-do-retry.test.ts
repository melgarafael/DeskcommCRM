import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import {
  claimJobs,
  enqueueJob,
  failJob,
  faltaParaOProximoJob,
  rescheduleJob,
} from "@/lib/agent-engine/queue/queue";

/**
 * O RETRY DA FILA PRECISA ESPERAR — E PRECISA ESPERAR ESTA ESCALA (PR #466).
 *
 * `failJob` devolve o job a `pending`. Enquanto ele não escrevia `run_after`, a
 * linha voltava para a fila **já vencida**, e o `claimJobs` seguinte a repegava
 * na mesma volta do laço. Medido nesta suíte, contra este mesmo Postgres, com o
 * `run_after` intocado: **12 rodadas de claim consecutivas queimaram as 5
 * tentativas em 42 ms** e abriram 1 `job_dead` crítico. Contra um erro
 * TRANSITÓRIO — 429 de TPM do provedor de LLM é o caso de campo — o rate limit
 * não teve UM INSTANTE para ceder entre uma tentativa e a outra: o job morre por
 * um incidente que um minuto de espera resolveria sozinho, e quem opera a VPS
 * recebe um alerta crítico por conversa.
 *
 * ## Por que isto merece catraca, e por que a catraca é de COMPORTAMENTO
 *
 * A linha que faz o conserto é UMA atribuição dentro do `set` de um `update`
 * multi-coluna. Ela é o tipo de perda que ninguém vê: some sem conflito quando
 * duas sessões mexem no mesmo `failJob` (o `set` continua sintaticamente válido
 * com uma coluna a menos), e nenhum grep de símbolo a acha — `run_after` aparece
 * outras oito vezes em `queue.ts`, no claim, no relógio e no `rescheduleJob`.
 * Sem esta catraca, o defeito volta com a suíte inteira verde.
 *
 * E não basta vigiar "esperou alguma coisa". Este arquivo prende a ESCALA em
 * números medidos, porque a expressão tem uma armadilha de um caractere: a
 * chave é `attempts - 1` (o `attempts` já vem incrementado do claim). Trocar
 * `greatest(attempts - 1, 0)` por `attempts` mantém tudo "no futuro" — um teste
 * que só perguntasse `run_after > now()` ficaria verde — e dobra toda a espera:
 * 20/40/80 em vez de 10/20/40, com o teto mordendo uma tentativa antes.
 *
 * ## Por que invariante e não unidade
 *
 * O que pode quebrar aqui é SQL, e a aritmética é de tipos do Postgres:
 * `power()` devolve `double precision`, `least(double, integer)` resolve para
 * `double precision`, e é esse double que multiplica o `interval`. Medido nos
 * dois motores (pg17.11 e pg15.19), o resultado é idêntico — ao contrário do
 * `'infinity'::timestamptz - now()` do relógio, que diverge entre 15 e 17. Nada
 * disso é observável fora de um Postgres de verdade.
 *
 * ## O que este arquivo deliberadamente NÃO afirma
 *
 * Que o teto de 120 s protege a instalação padrão. Ele NÃO morde com o
 * `max_attempts` do DDL (5): em `attempts = 5` o job já vai para `dead`, e a
 * maior espera que uma instalação padrão observa é 80 s. O caso do teto abaixo
 * força `max_attempts = 8` justamente para exercitar um ramo que o produto, hoje,
 * não alcança — e é a asserção que denuncia se alguém subir o `max_attempts`
 * achando que o teto já estava provado.
 *
 * Roda contra o Postgres efêmero do `scripts/test-db.sh`, com o `baseline.sql`
 * aplicado — o mesmo arquivo que o kit self-host instala.
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 2,
});

const ORG = "0be7a70a-2580-4000-8000-000000000466";
const CONTATO = "0be7a70a-2580-4000-8000-000000000467";
const ERRO_TRANSITORIO = new Error("429 rate limit reached for tokens (TPM)");

/**
 * Quanto falta, EM SEGUNDOS, até o job ficar reclamável — lido do banco, nunca
 * calculado no Node. Os dois relógios são diferentes: o `now()` desta consulta é
 * alguns milissegundos POSTERIOR ao `now()` do `update` que gravou o valor,
 * então a espera observada é sempre um pouco MENOR que a nominal (10 s vira
 * 9,99x). É por isso que as asserções abaixo usam faixa, e a faixa é fechada em
 * cima: `<= 10` é o que reprova a escala dobrada, não um arredondamento.
 */
async function esperaEmSegundos(jobId: string): Promise<number> {
  const { rows } = await pool.query<{ s: string }>(
    "select extract(epoch from (run_after - now()))::numeric(10,3) as s from job_queue where id = $1",
    [jobId],
  );
  return Number(rows[0]?.s);
}

async function estado(jobId: string): Promise<{ status: string; attempts: number }> {
  const { rows } = await pool.query<{ status: string; attempts: number }>(
    "select status, attempts from job_queue where id = $1",
    [jobId],
  );
  return rows[0]!;
}

/**
 * Faz o tempo passar SEM apagar o que o `failJob` escreveu: a medição da espera
 * já aconteceu quando esta função é chamada. Sem isto, observar a tentativa 4
 * custaria 10+20+40 = 70 segundos de relógio real dentro do CI.
 *
 * O que se adianta é o RELÓGIO, e não o estado: o job continua `pending` com o
 * `attempts` que ele tem, e quem o pega de volta é o `claimJobs` de produção.
 */
async function oTempoPassou(jobId: string): Promise<void> {
  await pool.query("update job_queue set run_after = now() - interval '1 second' where id = $1", [
    jobId,
  ]);
}

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, 'org-backoff-do-retry', 'Org Backoff do Retry LTDA', 'Org Backoff do Retry')
     on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number)
     values ($1, $2, 'Lead do Backoff', '+5511900000466')
     on conflict (id) do nothing`,
    [CONTATO, ORG],
  );
});

afterEach(async () => {
  await pool.query("delete from job_queue where organization_id = $1", [ORG]);
  await pool.query("delete from agent_inbox_items where organization_id = $1", [ORG]);
});

afterAll(async () => {
  await pool.query("delete from job_queue where organization_id = $1", [ORG]);
  await pool.query("delete from agent_inbox_items where organization_id = $1", [ORG]);
  await pool.query("delete from contacts where id = $1", [CONTATO]);
  await pool.query("delete from organizations where id = $1", [ORG]);
  await pool.end();
});

describe("failJob: backoff exponencial no retry", () => {
  it("cada tentativa espera o dobro da anterior — 10 s, 20 s, 40 s, 80 s", async () => {
    // A ESCALA, presa em número. `attempts` já vem incrementado do claim, então
    // a chave do expoente é `attempts - 1`: a 1ª falha espera 2^0 * 10 = 10 s.
    // Trocar a chave por `attempts` deixa tudo no futuro (e um teste frouxo
    // verde) enquanto dobra toda a escala.
    const { job } = await enqueueJob(pool, ORG, { kind: "inbound_turn", leadId: CONTATO });
    const esperado = [10, 20, 40, 80];

    for (const [i, segundos] of esperado.entries()) {
      const pegos = await claimJobs(pool, { workerId: "backoff", maxConcurrency: 8 });
      expect(pegos.map((j) => j.id), `tentativa ${i + 1}: o claim tinha de pegar o job`).toContain(
        job.id,
      );

      const devolvido = await failJob(pool, job.id, "backoff", ERRO_TRANSITORIO);
      expect(devolvido?.status, `tentativa ${i + 1}`).toBe("pending");
      expect((await estado(job.id)).attempts, `tentativa ${i + 1}`).toBe(i + 1);

      const espera = await esperaEmSegundos(job.id);
      expect(espera, `tentativa ${i + 1} devia esperar ${segundos}s`).toBeGreaterThan(segundos - 0.5);
      expect(espera, `tentativa ${i + 1} devia esperar ${segundos}s`).toBeLessThanOrEqual(segundos);

      await oTempoPassou(job.id);
    }
  });

  it("o job devolvido não é reclamável na hora — 12 claims seguidos não queimam as tentativas", async () => {
    // O CAMINHO DO USUÁRIO, sem nenhum ajuste de relógio: é o laço do
    // `workers/agent-worker/main.ts` (claim → handler lança → failJob) rodando
    // contra um erro que se repete. Antes do conserto isto media 5 claims com
    // job, `dead` e 1 alerta crítico em 42 ms. Depois, o job sai de circulação
    // na primeira falha e as 11 rodadas seguintes voltam vazias.
    const { job } = await enqueueJob(pool, ORG, { kind: "inbound_turn", leadId: CONTATO });

    let comJob = 0;
    for (let i = 0; i < 12; i++) {
      const pegos = await claimJobs(pool, { workerId: "queima", maxConcurrency: 8 });
      if (pegos.length === 0) continue;
      comJob += 1;
      await failJob(pool, job.id, "queima", ERRO_TRANSITORIO);
    }

    expect(comJob, "12 rodadas de claim só podiam alcançar o job UMA vez").toBe(1);
    const final = await estado(job.id);
    expect(final.status).toBe("pending");
    expect(final.attempts, "as outras 4 tentativas continuam disponíveis").toBe(1);

    const { rows: alertas } = await pool.query<{ n: string }>(
      "select count(*)::text as n from agent_inbox_items where organization_id = $1 and kind = 'job_dead'",
      [ORG],
    );
    expect(alertas[0]!.n, "nenhum job_dead podia ter sido aberto").toBe("0");
  });

  it("o relógio da fila enxerga a espera — o worker dorme em vez de girar", async () => {
    // O backoff só vira ECONOMIA porque `faltaParaOProximoJob` (o relógio que o
    // laço consulta antes de abrir o claim) devolve o intervalo. Se o conserto
    // vivesse em qualquer lugar que o relógio não lê, o worker continuaria
    // acordando no ritmo curto para encontrar a fila fechada — trocaria o
    // desperdício de tentativas pelo desperdício de rodadas.
    const { job } = await enqueueJob(pool, ORG, { kind: "inbound_turn", leadId: CONTATO });
    await claimJobs(pool, { workerId: "relogio", maxConcurrency: 8 });
    await failJob(pool, job.id, "relogio", ERRO_TRANSITORIO);

    const falta = await faltaParaOProximoJob(pool);
    expect(typeof falta).toBe("number");
    expect(falta, "o relógio tem de mandar o laço dormir ~10 s").toBeGreaterThan(8_000);
    expect(falta, "e 10 s, não 20 — a escala dobrada reprova aqui").toBeLessThanOrEqual(10_000);
  });

  it("o teto de 120 s morde, e só acima do max_attempts padrão", async () => {
    // Duas afirmações no mesmo caso porque elas se sustentam uma na outra: o
    // teto existe (attempts 5, 6 e 7 param em 120 s) E a instalação padrão
    // nunca o alcança (em attempts = 5 com max_attempts = 5 o job já é `dead`,
    // então 80 s é a maior espera que um self-hoster observa).
    const { job } = await enqueueJob(pool, ORG, {
      kind: "inbound_turn",
      leadId: CONTATO,
      maxAttempts: 8,
    });
    const esperado = [10, 20, 40, 80, 120, 120, 120];

    for (const [i, segundos] of esperado.entries()) {
      const pegos = await claimJobs(pool, { workerId: "teto", maxConcurrency: 8 });
      expect(pegos.map((j) => j.id), `tentativa ${i + 1}`).toContain(job.id);
      await failJob(pool, job.id, "teto", ERRO_TRANSITORIO);
      const espera = await esperaEmSegundos(job.id);
      expect(espera, `tentativa ${i + 1} devia esperar ${segundos}s`).toBeGreaterThan(segundos - 0.5);
      expect(espera, `tentativa ${i + 1} devia esperar ${segundos}s`).toBeLessThanOrEqual(segundos);
      await oTempoPassou(job.id);
    }

    // A 8ª esgota: `dead`, e a espera deixa de existir.
    await claimJobs(pool, { workerId: "teto", maxConcurrency: 8 });
    await failJob(pool, job.id, "teto", ERRO_TRANSITORIO);
    expect((await estado(job.id)).status).toBe("dead");
  });

  it("esgotar as tentativas não reagenda: vira dead com o run_after intocado e o aviso aberto", async () => {
    // O outro ramo do `case`. Um job `dead` não é lido por consumidor nenhum
    // pelo `run_after` — `claimJobs`, `faltaParaOProximoJob`, a coalescência do
    // drain e o `session-watchdog` filtram todos por `status = 'pending'`, e a
    // poda (`fn_podar_fila_de_jobs`) ordena por `created_at`. Deixar o valor
    // intocado é o que impede que o último write invente uma data futura numa
    // linha morta, que um painel futuro leria como "ainda vai rodar".
    const { job } = await enqueueJob(pool, ORG, { kind: "inbound_turn", leadId: CONTATO });
    await pool.query(
      "update job_queue set attempts = 4, run_after = now() - interval '7 minutes' where id = $1",
      [job.id],
    );
    const antes = await esperaEmSegundos(job.id);

    const pegos = await claimJobs(pool, { workerId: "morte", maxConcurrency: 8 });
    expect(pegos.map((j) => j.id)).toContain(job.id);
    const morto = await failJob(pool, job.id, "morte", ERRO_TRANSITORIO);

    expect(morto?.status).toBe("dead");
    expect(morto?.attempts).toBe(5);
    const depois = await esperaEmSegundos(job.id);
    expect(depois, "run_after de um job dead não pode ser reescrito").toBeGreaterThan(antes - 1);
    expect(depois, "e muito menos empurrado para o futuro").toBeLessThan(0);

    const { rows: alertas } = await pool.query<{ severity: string; body: string }>(
      "select severity, body from agent_inbox_items where organization_id = $1 and kind = 'job_dead'",
      [ORG],
    );
    expect(alertas).toHaveLength(1);
    expect(alertas[0]!.severity).toBe("critical");
    expect(alertas[0]!.body).toContain("429 rate limit");
  });

  it("a espera de SESSÃO não herda o backoff — rescheduleJob continua com o próprio atraso", async () => {
    // A fronteira do conserto. `rescheduleJob` é o caminho de espera de sessão
    // (resposta 'queued' do CRM): ele devolve o `attempts` e usa o delay que o
    // chamador pediu. Unificar os dois numa função só — a "simplificação" que
    // este caso existe para reprovar — daria 10 s de castigo a um job que não
    // falhou, e faria a espera de sessão consumir tentativa.
    const { job } = await enqueueJob(pool, ORG, { kind: "inbound_turn", leadId: CONTATO });
    await claimJobs(pool, { workerId: "sessao", maxConcurrency: 8 });
    const adiado = await rescheduleJob(pool, job.id, "sessao", {
      delayMs: 3_000,
      reason: "sessão do canal fora do ar",
    });

    expect(adiado?.status).toBe("pending");
    expect(adiado?.attempts, "espera de sessão não consome tentativa").toBe(0);
    const espera = await esperaEmSegundos(job.id);
    expect(espera).toBeGreaterThan(2.5);
    expect(espera).toBeLessThanOrEqual(3);
  });
});
