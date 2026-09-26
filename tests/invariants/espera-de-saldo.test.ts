import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import {
  PREFIXO_DA_ESPERA,
  adiarAteORecarregar,
  avisarFaltaDeSaldo,
  encerrarAvisoDeFaltaDeSaldo,
  esperouPorSaldo,
  jaNaoHaOQueResponder,
} from "@/lib/agent-engine/queue/espera-de-saldo";
import { claimJobs, enqueueJob } from "@/lib/agent-engine/queue/queue";

/**
 * PROVEDOR SEM SALDO — o SQL da espera, contra o `baseline.sql` real.
 *
 * Caso de campo (24/09/2026): a conta da Anthropic ficou sem crédito das 09:48
 * às 11:02; a fila queimou as 5 tentativas de cada resposta em 2,5 minutos e um
 * cliente nunca foi respondido pela IA. O conserto (`espera-de-saldo.ts`) põe o
 * job de volta na fila SEM gastar tentativa enquanto o saldo não volta.
 *
 * O que só um Postgres de verdade prova, e é o que este arquivo prende:
 *   - que a espera não gasta tentativa: dez adiamentos seguidos com
 *     `max_attempts = 5` e o job continua `pending` — nunca `dead`;
 *   - que o job volta do claim com a marca (`last_error`) que o worker lê para
 *     saber que ele esperou;
 *   - que o aviso na Central é UM por organização e aponta a credencial;
 *   - que "já respondida" lê as colunas da conversa com o filtro de organização.
 *
 * Roda contra o Postgres efêmero do `scripts/test-db.sh`.
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

const ORG = "5a1d0000-0000-4000-8000-000000000001";
const OUTRA_ORG = "5a1d0000-0000-4000-8000-000000000002";
const CONTATO = "5a1d0000-0000-4000-8000-000000000003";
const SESSAO = "5a1d0000-0000-4000-8000-000000000004";
const CONVERSA = "5a1d0000-0000-4000-8000-000000000005";
const CREDENCIAL = "5a1d0000-0000-4000-8000-000000000006";
const SEM_SALDO = Object.assign(
  new Error(
    "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
  ),
  { statusCode: 400 },
);

async function oTempoPassou(jobId: string): Promise<void> {
  await pool.query("update job_queue set run_after = now() - interval '1 second' where id = $1", [jobId]);
}

beforeAll(async () => {
  for (const [id, slug] of [
    [ORG, "org-espera-de-saldo"],
    [OUTRA_ORG, "org-espera-de-saldo-outra"],
  ] as const) {
    await pool.query(
      `insert into organizations (id, slug, legal_name, display_name, locale)
       values ($1, $2, 'Org Espera de Saldo LTDA', 'Org Espera de Saldo', 'es')
       on conflict (id) do nothing`,
      [id, slug],
    );
  }
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number)
     values ($1, $2, 'Lead da Espera', '+5511900000001') on conflict (id) do nothing`,
    [CONTATO, ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1, $2, 'espera-de-saldo', 'WORKING', '\\x00'::bytea) on conflict (id) do nothing`,
    [SESSAO, ORG],
  );
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group)
     values ($1, $2, $3, $4, 'open', false) on conflict (id) do nothing`,
    [CONVERSA, ORG, CONTATO, SESSAO],
  );
  await pool.query(
    `insert into ai_provider_credentials
       (id, organization_id, provider, label, api_key_encrypted, api_key_iv, api_key_tag, api_key_last4)
     values ($1, $2, 'anthropic', 'chave', '\\x00'::bytea, '\\x00'::bytea, '\\x00'::bytea, 'AAAA')
     on conflict (id) do nothing`,
    [CREDENCIAL, ORG],
  );
});

afterEach(async () => {
  await pool.query("delete from job_queue where organization_id = any($1)", [[ORG, OUTRA_ORG]]);
  await pool.query("delete from agent_inbox_items where organization_id = any($1)", [[ORG, OUTRA_ORG]]);
});

afterAll(async () => {
  await pool.query("delete from job_queue where organization_id = any($1)", [[ORG, OUTRA_ORG]]);
  await pool.query("delete from agent_inbox_items where organization_id = any($1)", [[ORG, OUTRA_ORG]]);
  await pool.query("delete from ai_provider_credentials where id = $1", [CREDENCIAL]);
  await pool.query("delete from conversations where id = $1", [CONVERSA]);
  await pool.query("delete from channel_sessions where id = $1", [SESSAO]);
  await pool.query("delete from contacts where id = $1", [CONTATO]);
  await pool.query("delete from organizations where id = any($1)", [[ORG, OUTRA_ORG]]);
  await pool.end();
});

describe("a resposta espera a recarga sem gastar tentativa", () => {
  it("dez esperas seguidas com max_attempts = 5 e o job continua vivo, marcado", async () => {
    const { job } = await enqueueJob(pool, ORG, {
      kind: "inbound_turn",
      leadId: CONTATO,
      payload: { conversation_id: CONVERSA },
    });
    for (let i = 0; i < 10; i += 1) {
      const pego = (await claimJobs(pool, { workerId: "espera", maxConcurrency: 8 })).find((j) => j.id === job.id);
      expect(pego, `volta ${i + 1}: o claim tinha de pegar o job`).toBeDefined();
      if (i > 0) expect(esperouPorSaldo(pego!), `volta ${i + 1}: a marca sobrevive ao claim`).toBe(true);
      const devolvido = await adiarAteORecarregar(pool, pego!, "espera", SEM_SALDO, pego!.claim_acquired_at);
      expect(devolvido?.status, `volta ${i + 1}`).toBe("pending");
      expect(devolvido?.attempts, `volta ${i + 1}: a espera não gasta tentativa`).toBe(0);
      expect(devolvido?.last_error?.startsWith(PREFIXO_DA_ESPERA)).toBe(true);
      await oTempoPassou(job.id);
    }
  });

  it("a próxima tentativa fica ~2 min à frente, lida do relógio do banco", async () => {
    const { job } = await enqueueJob(pool, ORG, { kind: "inbound_turn", leadId: CONTATO });
    const pego = (await claimJobs(pool, { workerId: "espera", maxConcurrency: 8 })).find((j) => j.id === job.id);
    expect(pego).toBeDefined();
    await adiarAteORecarregar(pool, pego!, "espera", SEM_SALDO, pego!.claim_acquired_at, Date.now());
    const { rows } = await pool.query<{ s: string }>(
      "select extract(epoch from (run_after - now()))::numeric(10,3) as s from job_queue where id = $1",
      [job.id],
    );
    expect(Number(rows[0]?.s)).toBeGreaterThan(115);
    expect(Number(rows[0]?.s)).toBeLessThanOrEqual(120);
  });
});

describe("o aviso na Central", () => {
  it("um só por organização, em espanhol, apontando a credencial — e fecha quando o saldo volta", async () => {
    await avisarFaltaDeSaldo(pool, ORG, SEM_SALDO);
    await avisarFaltaDeSaldo(pool, ORG, SEM_SALDO);
    const { rows } = await pool.query(
      "select kind, severity, title, ref_kind, ref_id, status from agent_inbox_items where organization_id = $1",
      [ORG],
    );
    expect(rows).toEqual([
      {
        kind: "other",
        severity: "critical",
        title: "La IA se quedó sin saldo en el proveedor",
        ref_kind: "ai_provider_credential",
        ref_id: CREDENCIAL,
        status: "open",
      },
    ]);

    await avisarFaltaDeSaldo(pool, OUTRA_ORG, SEM_SALDO);
    expect(await encerrarAvisoDeFaltaDeSaldo(pool, ORG)).toBe(1);
    const { rows: depois } = await pool.query<{ organization_id: string; status: string }>(
      "select organization_id, status from agent_inbox_items where organization_id = any($1) order by organization_id",
      [[ORG, OUTRA_ORG]],
    );
    // fechar o aviso de uma organização não toca no da outra
    expect(depois).toEqual([
      { organization_id: ORG, status: "resolved" },
      { organization_id: OUTRA_ORG, status: "open" },
    ]);
  });
});

describe("a conversa já foi respondida enquanto a IA esperava?", () => {
  const job = { kind: "inbound_turn" as const, organization_id: ORG, payload: { conversation_id: CONVERSA } };

  it("a última palavra é do cliente → ainda há o que responder", async () => {
    await pool.query(
      "update conversations set last_inbound_at = now(), last_outbound_at = now() - interval '5 minutes' where id = $1",
      [CONVERSA],
    );
    expect(await jaNaoHaOQueResponder(pool, job)).toBe(false);
  });

  it("alguém do nosso lado falou depois → não há o que responder", async () => {
    await pool.query(
      "update conversations set last_inbound_at = now() - interval '5 minutes', last_outbound_at = now() where id = $1",
      [CONVERSA],
    );
    expect(await jaNaoHaOQueResponder(pool, job)).toBe(true);
  });

  it("a conversa de outra organização não responde por esta", async () => {
    expect(await jaNaoHaOQueResponder(pool, { ...job, organization_id: OUTRA_ORG })).toBe(false);
  });
});
