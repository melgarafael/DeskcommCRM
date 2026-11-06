import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import { enforceHolds } from "@/lib/agent-engine/edge/crm/session-watchdog";
import { claimJobs, enqueueJob, faltaParaOProximoJob } from "@/lib/agent-engine/queue/queue";

/**
 * Reproduz o intervalo que o tick de cinco minutos não protege: o job nasce
 * vencido quando o canal JÁ está em hold e o worker tenta reivindicá-lo antes
 * de enforceHolds. O Postgres executa o claim e o relógio de produção; não há
 * um dublê que decida a elegibilidade pelo mesmo código do teste.
 */
if (!process.env.TEST_DB_CONTAINER) throw new Error("Rode por pnpm test:db");
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 2,
});
const ORG = "23270000-0000-4000-8000-000000000001";
const VIZINHA = "23270000-0000-4000-8000-000000000002";
const CONTATO = "23270000-0000-4000-8000-000000000011";
const CONTATO_VIZINHO = "23270000-0000-4000-8000-000000000012";
const CANAL = "23270000-0000-4000-8000-000000000021";
const OUTRO_NUMERO = "23270000-0000-4000-8000-000000000022";
const CANAL_VIZINHO = "23270000-0000-4000-8000-000000000023";
const CONVERSA = "23270000-0000-4000-8000-000000000031";
const OUTRA_CONVERSA = "23270000-0000-4000-8000-000000000032";
const ORGS = [ORG, VIZINHA];

beforeAll(async () => {
  for (const [id, slug] of [[ORG, "claim-hold-2327"], [VIZINHA, "claim-hold-vizinha-2327"]]) {
    await pool.query(
      `insert into organizations (id, slug, legal_name, display_name)
       values ($1, $2, 'Org do Hold LTDA', 'Org do Hold')`, [id, slug],
    );
  }
  for (const [id, org, telefone] of [[CONTATO, ORG, "+5511900002327"], [CONTATO_VIZINHO, VIZINHA, "+5511900002328"]]) {
    await pool.query(
      `insert into contacts (id, organization_id, name, phone_number) values ($1, $2, 'Contato sintético', $3)`,
      [id, org, telefone],
    );
  }
  for (const [id, org] of [[CANAL, ORG], [OUTRO_NUMERO, ORG], [CANAL_VIZINHO, VIZINHA]]) {
    await pool.query(
      `insert into channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted, status)
       values ($1, $2, $3, '\\x00'::bytea, 'WORKING')`, [id, org, `claim-hold-${id}`],
    );
    // Estes casos medem retenção e espaçamento, sem cruzar a janela noturna.
    // Só a fixture usa 24h UTC; os defaults e a regra de horário ficam intactos.
    await pool.query(
      `insert into channel_knobs
         (organization_id, channel_session_id, window_start_hour, window_end_hour, timezone, allow_sunday)
       values ($1, $2, 0, 24, 'UTC', true)`, [org, id],
    );
  }
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id)
     values ($1, $3, $4, $5), ($2, $3, $4, $6)`,
    [CONVERSA, OUTRA_CONVERSA, ORG, CONTATO, CANAL, OUTRO_NUMERO],
  );
});

beforeEach(async () => {
  await pool.query(`update channel_sessions set status = 'WORKING' where organization_id = any($1::uuid[])`, [ORGS]);
  await pool.query(`delete from channel_session_health where organization_id = any($1::uuid[])`, [ORGS]);
});

afterEach(async () => {
  await pool.query(`delete from job_queue where organization_id = any($1::uuid[])`, [ORGS]);
});

afterAll(async () => {
  await pool.query(`delete from job_queue where organization_id = any($1::uuid[])`, [ORGS]);
  await pool.query(`delete from channel_session_health where organization_id = any($1::uuid[])`, [ORGS]);
  await pool.query(`delete from conversations where organization_id = any($1::uuid[])`, [ORGS]);
  await pool.query(`delete from channel_knobs where organization_id = any($1::uuid[])`, [ORGS]);
  await pool.query(`delete from channel_sessions where organization_id = any($1::uuid[])`, [ORGS]);
  await pool.query(`delete from contacts where organization_id = any($1::uuid[])`, [ORGS]);
  await pool.query(`delete from organizations where id = any($1::uuid[])`, [ORGS]);
  await pool.end();
});

async function hold(razao: string | null, ativo = true): Promise<void> {
  await pool.query(
    `insert into channel_session_health (organization_id, channel_session_id, status, health_hold_active, health_hold_reason)
     values ($1, $2, 'WORKING', $3, $4)
     on conflict (organization_id, channel_session_id)
     do update set health_hold_active = excluded.health_hold_active, health_hold_reason = excluded.health_hold_reason`,
    [ORG, CANAL, ativo, razao],
  );
}

async function job(kind: "inbound_turn" | "followup_turn", payload: Record<string, unknown>, priority = 100) {
  return (await enqueueJob(pool, ORG, { kind, leadId: CONTATO, payload, priority })).job;
}

const claim = () => claimJobs(pool, { workerId: "worker-claim-hold-2327", maxConcurrency: 4 });
const pelaConversa = (id = CONVERSA) => ({ service_boundary: { conversation_id: id } });

describe("claim e relógio antes do tick de retenção (#2327)", () => {
  it.each([
    ["payload direto", { channel_session_id: CANAL }],
    ["conversa real do atendimento", pelaConversa()],
  ])("não reivindica follow-up sob go-live (%s), não gasta tentativa nem gira o relógio", async (_nome, payload) => {
    await hold("go_live");
    const retorno = await job("followup_turn", payload);
    await expect(faltaParaOProximoJob(pool)).resolves.toBe(0);
    expect(await claim()).toEqual([]);
    await expect(faltaParaOProximoJob(pool)).resolves.toBe(86_400_000);
    const { rows } = await pool.query(`select status, attempts from job_queue where id = $1`, [retorno.id]);
    expect(rows[0]).toEqual({ status: "pending", attempts: 0 });
  });

  it("a resposta ao cliente não fica atrás do follow-up retido na mesma lane", async () => {
    await hold("go_live");
    await job("followup_turn", pelaConversa(), 1);
    const resposta = await job("inbound_turn", { channel_session_id: CANAL }, 100);
    await expect(faltaParaOProximoJob(pool)).resolves.toBe(0);
    expect((await claim()).map((j) => j.id)).toEqual([resposta.id]);
  });

  it.each(["block_rate", "response_rate"])("o hold %s impede também a resposta", async (razao) => {
    await hold(razao);
    await job("followup_turn", pelaConversa());
    await job("inbound_turn", { channel_session_id: CANAL });
    await expect(faltaParaOProximoJob(pool)).resolves.toBe(0);
    expect(await claim()).toEqual([]);
    await expect(faltaParaOProximoJob(pool)).resolves.toBe(86_400_000);
  });

  it("canal fora do ar impede os dois turnos mesmo sem linha de saúde", async () => {
    await pool.query(`update channel_sessions set status = 'STOPPED' where id = $1`, [CANAL]);
    await job("followup_turn", pelaConversa());
    await job("inbound_turn", { channel_session_id: CANAL });
    await expect(faltaParaOProximoJob(pool)).resolves.toBe(0);
    expect(await claim()).toEqual([]);
    await expect(faltaParaOProximoJob(pool)).resolves.toBe(86_400_000);
  });

  it("o hold de um número não cala a conversa do mesmo contato em outro número", async () => {
    await hold("go_live");
    await job("followup_turn", pelaConversa(), 1);
    const liberado = await job("followup_turn", pelaConversa(OUTRA_CONVERSA), 100);
    expect((await claim()).map((j) => j.id)).toEqual([liberado.id]);
  });

  it("o hold de uma organização não impede o canal da vizinha", async () => {
    await hold("go_live");
    await job("followup_turn", pelaConversa());
    const vizinho = (await enqueueJob(pool, VIZINHA, {
      kind: "followup_turn", leadId: CONTATO_VIZINHO, payload: { channel_session_id: CANAL_VIZINHO },
    })).job;
    expect((await claim()).map((j) => j.id)).toEqual([vizinho.id]);
  });

  it("um id de conversa malformado não aborta o claim de toda a instalação", async () => {
    await hold("go_live");
    const semCanal = await job("followup_turn", pelaConversa("nao-e-uuid"));
    expect((await claim()).map((j) => j.id)).toEqual([semCanal.id]);
  });

  it("retidos voltam espaçados quando o watchdog libera o número", async () => {
    await hold("go_live");
    for (let i = 0; i < 3; i++) await job("followup_turn", pelaConversa());
    expect((await enforceHolds(pool)).held).toBe(3);
    await hold(null, false);
    expect((await enforceHolds(pool)).released).toBe(3);
    const { rows } = await pool.query<{ run_after: Date; payload: Record<string, unknown> }>(
      `select run_after, payload from job_queue where organization_id = $1 order by run_after`, [ORG],
    );
    expect(rows[1]!.run_after.getTime() - rows[0]!.run_after.getTime()).toBe(5 * 60_000);
    expect(rows[2]!.run_after.getTime() - rows[1]!.run_after.getTime()).toBe(5 * 60_000);
    expect(rows.every((j) => !("held_run_after" in j.payload) && !("held_channel_session_id" in j.payload))).toBe(true);
  });

  it("retém no claim e libera espaçado mesmo quando o aviso é resolvido antes do próximo tick", async () => {
    await hold("go_live");
    for (let i = 0; i < 3; i++) await job("followup_turn", pelaConversa());
    expect(await claim()).toEqual([]);
    const retidos = await pool.query<{ retido: boolean; attempts: number }>(
      `select run_after = 'infinity' and payload ? 'held_run_after'
              and payload->>'held_channel_session_id' = $2 as retido, attempts
         from job_queue where organization_id = $1`, [ORG, CANAL],
    );
    expect(retidos.rows).toHaveLength(3);
    expect(retidos.rows.every((j) => j.retido && j.attempts === 0)).toBe(true);
    await expect(faltaParaOProximoJob(pool)).resolves.toBe(86_400_000);

    // O humano resolveu antes do tick: a rodada seguinte precisa encontrar as
    // marcas de retenção, apesar de a saúde JÁ estar liberada quando ela começa.
    await hold(null, false);
    expect((await enforceHolds(pool)).released).toBe(3);
    const { rows } = await pool.query<{ run_after: Date }>(
      `select run_after from job_queue where organization_id = $1 order by run_after`, [ORG],
    );
    expect(rows[1]!.run_after.getTime() - rows[0]!.run_after.getTime()).toBe(5 * 60_000);
    expect(rows[2]!.run_after.getTime() - rows[1]!.run_after.getTime()).toBe(5 * 60_000);
  });

  it("uma linha sob hold travada por outra conexão não bloqueia o claim saudável", async () => {
    await hold("go_live");
    const retido = await job("followup_turn", pelaConversa(), 1);
    const saudavel = await job("followup_turn", pelaConversa(OUTRA_CONVERSA), 100);
    const trava = await pool.connect();
    const concorrente = new pg.Pool({ ...pool.options, max: 1, statement_timeout: 750 });
    try {
      await trava.query("begin");
      await trava.query("select id from job_queue where id = $1 for update", [retido.id]);
      const jobs = await claimJobs(concorrente, { workerId: "worker-vizinho-2327", maxConcurrency: 4 });
      expect(jobs.map((j) => j.id)).toEqual([saudavel.id]);
    } finally {
      await trava.query("rollback");
      trava.release();
      await concorrente.end();
    }
  });
});
