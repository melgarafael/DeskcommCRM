/**
 * A CONSULTA DE `loadChannelKnobs` CONTRA POSTGRES REAL.
 *
 * O caso unitário (`tests/unit/janela-no-fuso-da-organizacao.test.ts`) injeta a
 * linha pronta, com `org_timezone` já dentro — e por isso continuaria verde se
 * a consulta voltasse a ler só `channel_knobs`. Aqui não há dublê: a linha sai
 * do `left join` de verdade, sobre o schema do `baseline.sql`.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PACING_DEFAULTS } from "@/lib/agent-engine/pacing/defaults";
import { loadChannelKnobs } from "@/lib/agent-engine/pacing/store";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 2,
});
afterAll(() => pool.end());

const lisboa = { org: randomUUID(), canal: randomUUID() };
const comKnobs = { org: randomUUID(), canal: randomUUID() };
const fusoInvalido = { org: randomUUID(), canal: randomUUID() };

async function semear(par: { org: string; canal: string }, timezone: string) {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name, timezone) values ($1::uuid, $1::text, 'Janela', 'Janela', $2)`,
    [par.org, timezone],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
     values ($1::uuid, $2, $1::text, '\\x00')`,
    [par.canal, par.org],
  );
}

beforeAll(async () => {
  await semear(lisboa, "Europe/Lisbon");
  await semear(comKnobs, "Europe/Lisbon");
  await semear(fusoInvalido, "Europe/Lisboa");
  await pool.query(
    `insert into channel_knobs (organization_id, channel_session_id, timezone, window_start_hour,
                                warmup_daily_caps, number_activated_at)
     values ($1, $2, 'Asia/Tokyo', 9, '[{"minAgeDays":0,"cap":null}]', '2026-01-01T00:00:00Z')`,
    [comKnobs.org, comKnobs.canal],
  );
});

describe("o fuso da janela, lido do banco", () => {
  it("número sem linha em channel_knobs: vale o fuso da organização", async () => {
    const { knobs, numberActivatedAt } = await loadChannelKnobs(pool, lisboa.org, lisboa.canal);
    expect(knobs.timezone).toBe("Europe/Lisbon");
    // O resto da linha segue os defaults, como antes da consulta partir da organização.
    expect({ ...knobs, timezone: PACING_DEFAULTS.timezone }).toEqual(PACING_DEFAULTS);
    expect(numberActivatedAt).toBeNull();
  });

  it("número com fuso próprio: o do número vence, e o resto da linha é lido", async () => {
    const { knobs, numberActivatedAt } = await loadChannelKnobs(pool, comKnobs.org, comKnobs.canal);
    expect(knobs.timezone).toBe("Asia/Tokyo");
    expect(knobs.windowStartHour).toBe(9);
    expect(knobs.warmupDailyCaps).toEqual([{ minAgeDays: 0, cap: null }]);
    expect(new Date(numberActivatedAt as Date).toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("fuso da organização que o Intl recusa: cai no padrão, não derruba o envio", async () => {
    const { knobs } = await loadChannelKnobs(pool, fusoInvalido.org, fusoInvalido.canal);
    expect(knobs.timezone).toBe(PACING_DEFAULTS.timezone);
  });

  it("o número de uma organização lido com o id de OUTRA não traz os knobs dela", async () => {
    // O canal com knobs de Tóquio, pedido pela organização de Lisboa: o join
    // exige a MESMA organização, então nada da linha alheia atravessa.
    const { knobs } = await loadChannelKnobs(pool, lisboa.org, comKnobs.canal);
    expect(knobs.timezone).toBe("Europe/Lisbon");
    expect(knobs.windowStartHour).toBe(PACING_DEFAULTS.windowStartHour);
  });
});
