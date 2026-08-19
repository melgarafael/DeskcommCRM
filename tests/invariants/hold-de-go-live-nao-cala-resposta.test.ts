import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { enforceHolds } from "@/lib/agent-engine/edge/crm/session-watchdog";

/**
 * O hold de go-live segura DISPARO, não RESPOSTA.
 *
 * Defeito medido numa instalação real (2026-08-18): número novo nasce em hold
 * `go_live` — fail-safe correto — e o `enforceHolds` olhava só o booleano
 * `health_hold_active`, mandando TODO `inbound_turn` da sessão para
 * `run_after = 'infinity'`. O lead escrevia "Oi", a tela dizia "IA atendendo",
 * o agente publicado nunca rodava, e o único sinal era um item de Central
 * marcado `info` falando de "outbound". Horas de silêncio.
 *
 * Invariante e não unidade porque o que pode quebrar é SQL: a regra vive num
 * `update … from channel_sessions left join channel_session_health` e o ramo
 * novo depende de `is distinct from` com linha de saúde possivelmente ausente —
 * semântica que só o Postgres decide.
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

const ORG = "0be7a70a-2580-4000-8000-000000000101";
const CONTATO = "0be7a70a-2580-4000-8000-000000000102";
const SESSAO = "0be7a70a-2580-4000-8000-000000000103";

async function enfileirar(kind: "inbound_turn" | "followup_turn", jaRetido = false): Promise<void> {
  const payload = jaRetido
    ? `jsonb_build_object('channel_session_id', $2::text, 'held_run_after', to_jsonb(now()))`
    : `jsonb_build_object('channel_session_id', $2::text)`;
  await pool.query(
    `insert into job_queue (organization_id, contact_id, kind, payload, status, run_after)
     values ($1, $3, $4, ${payload}, 'pending', ${jaRetido ? "'infinity'" : "now()"})`,
    [ORG, SESSAO, CONTATO, kind],
  );
}

async function estado(): Promise<Record<string, { retido: boolean }>> {
  const { rows } = await pool.query<{ kind: string; retido: boolean }>(
    `select kind, (payload ? 'held_run_after') as retido
     from job_queue where organization_id = $1`,
    [ORG],
  );
  return Object.fromEntries(rows.map((r) => [r.kind, { retido: r.retido }]));
}

async function saude(opts: {
  ativo: boolean;
  razao: string | null;
  statusDaSessao?: string;
}): Promise<void> {
  await pool.query(`update channel_sessions set status = $2 where id = $1`, [
    SESSAO,
    opts.statusDaSessao ?? "WORKING",
  ]);
  await pool.query(
    `insert into channel_session_health (organization_id, channel_session_id, status, health_hold_active, health_hold_reason)
     values ($1, $2, 'WORKING', $3, $4)
     on conflict (organization_id, channel_session_id)
     do update set health_hold_active = excluded.health_hold_active,
                   health_hold_reason = excluded.health_hold_reason`,
    [ORG, SESSAO, opts.ativo, opts.razao],
  );
}

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, 'org-hold-go-live', 'Org Hold LTDA', 'Org Hold') on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number)
     values ($1, $2, 'Lead do Hold', '+5511900000101') on conflict (id) do nothing`,
    [CONTATO, ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted, status)
     values ($1, $2, 'sessao-hold', '\\x00'::bytea, 'WORKING') on conflict (id) do nothing`,
    [SESSAO, ORG],
  );
});

afterEach(async () => {
  await pool.query("delete from job_queue where organization_id = $1", [ORG]);
});

afterAll(async () => {
  await pool.query("delete from job_queue where organization_id = $1", [ORG]);
  await pool.query("delete from channel_session_health where organization_id = $1", [ORG]);
  await pool.query("delete from channel_sessions where id = $1", [SESSAO]);
  await pool.query("delete from contacts where id = $1", [CONTATO]);
  await pool.query("delete from organizations where id = $1", [ORG]);
  await pool.end();
});

describe("enforceHolds sob hold de go-live", () => {
  it("retém o follow-up e DEIXA a resposta ao cliente passar", async () => {
    await saude({ ativo: true, razao: "go_live" });
    await enfileirar("inbound_turn");
    await enfileirar("followup_turn");

    const { held } = await enforceHolds(pool);

    expect(held).toBe(1);
    expect(await estado()).toEqual({
      inbound_turn: { retido: false },
      followup_turn: { retido: true },
    });
  });

  it("LIBERA resposta que ficou retida pela regra antiga (clone que atualiza)", async () => {
    // Quem já rodou a versão anterior tem `inbound_turn` parado em 'infinity'.
    // Atualizar o código não pode exigir mexer no banco à mão: o próprio tick
    // devolve o job à fila.
    await saude({ ativo: true, razao: "go_live" });
    await enfileirar("inbound_turn", true);
    await enfileirar("followup_turn", true);

    const { released } = await enforceHolds(pool);

    expect(released).toBe(1);
    expect(await estado()).toEqual({
      inbound_turn: { retido: false },
      followup_turn: { retido: true },
    });
  });
});

describe("enforceHolds nos holds que NÃO são go-live", () => {
  it("número degradado (block_rate) continua segurando os dois", async () => {
    // Aqui a suspeita recai sobre o próprio número, não sobre a iniciativa do
    // disparo — o comportamento anterior é o certo e não pode ter regredido.
    await saude({ ativo: true, razao: "block_rate" });
    await enfileirar("inbound_turn");
    await enfileirar("followup_turn");

    const { held } = await enforceHolds(pool);

    expect(held).toBe(2);
    expect(await estado()).toEqual({
      inbound_turn: { retido: true },
      followup_turn: { retido: true },
    });
  });

  it("canal fora do ar segura os dois, mesmo sem hold de saúde", async () => {
    await saude({ ativo: false, razao: null, statusDaSessao: "STOPPED" });
    await enfileirar("inbound_turn");
    await enfileirar("followup_turn");

    const { held } = await enforceHolds(pool);

    expect(held).toBe(2);
    expect(await estado()).toEqual({
      inbound_turn: { retido: true },
      followup_turn: { retido: true },
    });
  });

  it("sem hold e com canal no ar, nada é retido e o que estava preso volta", async () => {
    await saude({ ativo: false, razao: null });
    await enfileirar("inbound_turn", true);
    await enfileirar("followup_turn", true);

    const { held, released } = await enforceHolds(pool);

    expect(held).toBe(0);
    expect(released).toBe(2);
    expect(await estado()).toEqual({
      inbound_turn: { retido: false },
      followup_turn: { retido: false },
    });
  });
});
