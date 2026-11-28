/**
 * AGENDA DO OUTLOOK (#1754, migration 9511) — medida no Postgres.
 *
 * 1. A credencial da instalação não é servida ao navegador.
 * 2. Só o service_role grava o espelho de ocupação.
 * 3. A gravação troca a ocupação da agenda e ela passa a bloquear o dono.
 * 4. Conta desconectada não regrava nada.
 * 5. Salvar a escolha do Google não desliga a agenda do Outlook.
 */
import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GOV_AGENT_A, GOV_ORG, seedGov } from "./gov-helpers";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 2,
});

const MICROSOFT = randomUUID();
const AGENDA_MICROSOFT = randomUUID();
const GOOGLE = randomUUID();
const AGENDA_GOOGLE = randomUUID();
const JANELA = ["2030-03-01T00:00:00.000Z", "2030-04-01T00:00:00.000Z"];
const SALVAR = "select public.fn_microsoft_calendar_save($1,$2,$3::jsonb,$4,$5) as total";
const item = (id: string, inicio: string) => ({
  external_event_id: id,
  starts_at: inicio,
  ends_at: new Date(Date.parse(inicio) + 3_600_000).toISOString(),
  is_all_day: false,
  status: "confirmed",
  transparency: "opaque",
  ical_uid: null,
});

async function como<T>(papel: string, claims: Record<string, unknown>, f: (c: pg.PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`set local role ${papel}`);
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    return await f(client);
  } finally {
    await client.query("rollback");
    client.release();
  }
}

beforeAll(async () => {
  seedGov();
  for (const [conexao, agenda, provedor, destino] of [
    [MICROSOFT, AGENDA_MICROSOFT, "microsoft_calendar", false],
    [GOOGLE, AGENDA_GOOGLE, "google_calendar", true],
  ] as const) {
    await pool.query(
      `insert into calendar_connections(id, organization_id, user_id, provider, account_email, status)
       values ($1,$2,$3,$4,$5,'healthy')`,
      [conexao, GOV_ORG, GOV_AGENT_A, provedor, `${conexao}@invariant.test`],
    );
    await pool.query(
      `insert into calendar_connection_calendars(id, organization_id, connection_id, external_calendar_id, name, is_destination, counts_for_conflicts, access_role)
       values ($1,$2,$3,'principal','Principal',$4,true,$5)`,
      [agenda, GOV_ORG, conexao, destino, destino ? "owner" : "reader"],
    );
  }
});

afterAll(() => pool.end());

describe("a credencial da Microsoft é server-side", () => {
  it.each(["anon", "authenticated"])("%s não tem privilégio nenhum", async (papel) => {
    const r = await pool.query(
      `select count(*)::int as n from information_schema.role_table_grants
        where table_schema='public' and table_name='platform_microsoft_oauth' and grantee=$1`,
      [papel],
    );
    expect(r.rows[0].n).toBe(0);
    await expect(
      como(papel, { role: papel }, (c) => c.query("select * from public.platform_microsoft_oauth")),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("controle: service_role lê", async () => {
    await expect(
      como("service_role", { role: "service_role" }, (c) => c.query("select * from public.platform_microsoft_oauth")),
    ).resolves.toBeDefined();
  });
});

describe("fn_microsoft_calendar_save", () => {
  const args = (itens: unknown[]) => [GOV_ORG, AGENDA_MICROSOFT, JSON.stringify(itens), ...JANELA];

  it.each(["anon", "authenticated"])("%s não executa", async (papel) => {
    await expect(
      como(papel, { role: papel, sub: GOV_AGENT_A }, (c) => c.query(SALVAR, args([]))),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("troca o espelho, carimba a cobertura e passa a ocupar o dono", async () => {
    await como("service_role", { role: "service_role" }, async (c) => {
      await c.query(SALVAR, args([item("antigo", "2030-03-10T13:00:00.000Z")]));
      const r = await c.query(SALVAR, args([item("novo", "2030-03-12T13:00:00.000Z")]));
      expect(r.rows[0].total).toBe(1);
      const ocupado = await c.query(
        "select starts_at from public.fn_agenda_ocupacao_google_do_dono($1,$2,$3,$4)",
        [GOV_ORG, GOV_AGENT_A, ...JANELA],
      );
      expect(ocupado.rows.map((l) => new Date(l.starts_at).toISOString())).toEqual(["2030-03-12T13:00:00.000Z"]);
      const agenda = await c.query(
        "select sync_coverage, last_sync_at, sync_error from calendar_connection_calendars where id=$1",
        [AGENDA_MICROSOFT],
      );
      expect(agenda.rows[0].sync_coverage).toMatchObject({ generation: expect.any(String) });
      expect(agenda.rows[0].last_sync_at).not.toBeNull();
    });
  });

  it("conta desconectada não grava", async () => {
    await expect(
      como("postgres", { role: "service_role" }, async (c) => {
        await c.query("update calendar_connections set status='disconnected' where id=$1", [MICROSOFT]);
        await c.query(SALVAR, args([]));
      }),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("não alcança agenda do Google", async () => {
    await expect(
      como("service_role", { role: "service_role" }, (c) =>
        c.query(SALVAR, [GOV_ORG, AGENDA_GOOGLE, "[]", ...JANELA]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });
});

describe("a escolha do Google não mexe no Outlook", () => {
  it("salvar a seleção do Google mantém a agenda do Outlook contando", async () => {
    await como("authenticated", { role: "authenticated", sub: GOV_AGENT_A }, async (c) => {
      const rev = await c.query(
        "select calendar_selection_revision::text as r from calendar_connections where id=$1",
        [GOOGLE],
      );
      await c.query("select public.fn_google_selection($1,$2::jsonb,$3::uuid[],$4)", [
        GOV_ORG,
        JSON.stringify([{ connection_id: GOOGLE, revision: rev.rows[0].r }]),
        [],
        AGENDA_GOOGLE,
      ]);
      const r = await c.query(
        "select counts_for_conflicts from calendar_connection_calendars where id=$1",
        [AGENDA_MICROSOFT],
      );
      expect(r.rows[0].counts_for_conflicts).toBe(true);
    });
  });
});
