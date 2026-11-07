import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * EDITAR A EQUIPE DE UM COMPROMISSO QUE JÁ EXISTE (#4006, migration 9209).
 *
 * `fn_appointment_change_core` aplica `p_patch` por LISTA FECHADA. Sem a cláusula
 * de `team_guest_user_ids`, o PATCH da rota devolvia 200 e a lista ficava como
 * estava: a pessoa era "tirada" do convite e seguia convidada. O dublê de unidade
 * não enxerga isso; só a RPC de verdade, em Postgres.
 *
 * `revision` fica parada de propósito (a equipe é conteúdo, como `guest_email`, e
 * subir faria o CAS da tela recusar a edição seguinte). Quem anda é
 * `google_local_revision`: é ela que leva a mudança ao Google.
 */

const pool = new pg.Pool({
  connectionString:
    process.env.TEST_DATABASE_URL ??
    `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
});

const org = randomUUID();
const manager = randomUUID();
const bruna = randomUUID();
const caio = randomUUID();
const duda = randomUUID();
const revogada = randomUUID();
const outraOrg = randomUUID();
const deFora = randomUUID();

async function comUsuario<T>(run: (db: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ sub: manager, role: "authenticated", aal: "aal1" }),
    ]);
    const r = await run(client);
    await client.query("commit");
    return r;
  } catch (erro) {
    await client.query("rollback");
    throw erro;
  } finally {
    client.release();
  }
}

async function compromisso(): Promise<string> {
  const id = randomUUID();
  const inicio = new Date(Date.now() + 3 * 3_600_000);
  await pool.query(
    "insert into calendar_appointments(id,organization_id,owner_user_id,title,starts_at,ends_at,status,time_zone,team_guest_user_ids) values($1,$2,$3,'Com a equipe',$4,$5,'confirmed','America/Sao_Paulo',$6::uuid[])",
    [id, org, manager, inicio, new Date(inicio.getTime() + 3_600_000), [bruna, caio]],
  );
  return id;
}

async function linha(id: string) {
  const r = await pool.query(
    "select team_guest_user_ids, revision, google_local_revision from calendar_appointments where id=$1",
    [id],
  );
  return r.rows[0] as {
    team_guest_user_ids: string[];
    revision: string;
    google_local_revision: string;
  };
}

function altera(id: string, revisao: number, patch: Record<string, unknown>) {
  return comUsuario((db) =>
    db.query("select fn_appointment_change($1,$2,$3,$4)", [org, id, revisao, patch]),
  );
}

beforeAll(async () => {
  await pool.query(
    "insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Equipe na edição','Equipe na edição')",
    [org],
  );
  await pool.query(
    "insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Outra','Outra')",
    [outraOrg],
  );
  for (const usuario of [manager, bruna, caio, duda, revogada, deFora]) {
    await pool.query("insert into auth.users(id,email) values($1,$2)", [
      usuario,
      `${usuario}@invariant.test`,
    ]);
  }
  await pool.query(
    "insert into user_organizations(organization_id,user_id,role,accepted_at) values($1,$2,'manager',now())",
    [org, manager],
  );
  for (const membro of [bruna, caio, duda]) {
    await pool.query(
      "insert into user_organizations(organization_id,user_id,role,accepted_at) values($1,$2,'agent',now())",
      [org, membro],
    );
  }
  await pool.query(
    "insert into user_organizations(organization_id,user_id,role,accepted_at,revoked_at) values($1,$2,'agent',now(),now())",
    [org, revogada],
  );
  await pool.query(
    "insert into user_organizations(organization_id,user_id,role,accepted_at) values($1,$2,'agent',now())",
    [outraOrg, deFora],
  );
});
afterAll(() => pool.end());

describe("a equipe do compromisso é editável pela RPC de transição (#4006)", () => {
  it("troca a lista, grava, e o carimbo do Google anda sem mexer na revisão do CAS", async () => {
    const id = await compromisso();
    const antes = await linha(id);

    await altera(id, 1, { team_guest_user_ids: [bruna, duda] });

    const depois = await linha(id);
    expect(depois.team_guest_user_ids).toEqual([bruna, duda]);
    expect(Number(depois.revision)).toBe(1);
    expect(Number(depois.google_local_revision)).toBe(Number(antes.google_local_revision) + 1);
  });

  it("`[]` desconvida todo mundo e também vai ao Google", async () => {
    const id = await compromisso();
    const antes = await linha(id);

    await altera(id, 1, { team_guest_user_ids: [] });

    const depois = await linha(id);
    expect(depois.team_guest_user_ids).toEqual([]);
    expect(Number(depois.google_local_revision)).toBe(Number(antes.google_local_revision) + 1);
  });

  it("patch SEM a chave preserva a lista: ausente não é vazio", async () => {
    const id = await compromisso();
    const antes = await linha(id);

    await altera(id, 1, { notes: "só a observação" });

    const depois = await linha(id);
    expect(depois.team_guest_user_ids).toEqual([bruna, caio]);
    expect(depois.google_local_revision).toBe(antes.google_local_revision);
  });

  it("a mudança vinda do Google não alcança a lista", async () => {
    const id = await compromisso();

    await expect(
      pool.query("select fn_appointment_change_core($1,$2,1,$3,true,'{}'::jsonb)", [
        org,
        id,
        { team_guest_user_ids: [] },
      ]),
    ).rejects.toThrow(/google_patch_forbidden/);

    expect((await linha(id)).team_guest_user_ids).toEqual([bruna, caio]);
  });

  it("revisão velha é PT409 e a lista não muda", async () => {
    const id = await compromisso();

    await expect(altera(id, 99, { team_guest_user_ids: [duda] })).rejects.toMatchObject({
      code: "PT409",
    });

    expect((await linha(id)).team_guest_user_ids).toEqual([bruna, caio]);
  });

  it.each([
    ["uma lista", () => bruna],
    ["um objeto", () => ({ id: bruna })],
    ["nulo no lugar da lista", () => null],
    ["um nulo na lista", () => [bruna, null]],
    ["um id que não é uuid", () => ["bruna"]],
    ["mais de 20 ids", () => Array.from({ length: 21 }, () => bruna)],
    ["quem saiu da organização", () => [bruna, revogada]],
    ["quem é de outra organização", () => [bruna, deFora]],
    ["quem nunca foi da organização", () => [randomUUID()]],
  ])("a lista recusa %s com erro nomeado, e nada muda", async (_nome, valor) => {
    const id = await compromisso();

    await expect(altera(id, 1, { team_guest_user_ids: valor() })).rejects.toMatchObject({
      code: "22023",
      message: expect.stringContaining("appointment_team_guests_invalid"),
    });

    expect((await linha(id)).team_guest_user_ids).toEqual([bruna, caio]);
  });
});
