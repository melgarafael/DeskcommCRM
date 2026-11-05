import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, expect, it } from "vitest";
if (!process.env.TEST_DB_CONTAINER) throw new Error("Rode via pnpm test:db");
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 1,
});
afterAll(() => pool.end());
it("recusa etapa de outro funil e organização sem corrigir dados silenciosamente", async () => {
  const c = await pool.connect();
  const [org, other, p1, p2, foreign, s1, s2, sf, lead] = Array.from({ length: 9 }, () =>
    randomUUID(),
  );
  try {
    await c.query("begin");
    for (const id of [org, other])
      await c.query(
        "insert into organizations(id,slug,legal_name,display_name) values($1,$2,'Synthetic','Synthetic')",
        [id, id],
      );
    for (const [id, o] of [
      [p1, org],
      [p2, org],
      [foreign, other],
    ])
      await c.query(
        "insert into crm_pipelines(id,organization_id,name,slug) values($1,$2,'Synthetic',$3)",
        [id, o, id],
      );
    for (const [id, o, p] of [
      [s1, org, p1],
      [s2, org, p2],
      [sf, other, foreign],
    ])
      await c.query(
        "insert into crm_stages(id,organization_id,pipeline_id,name,slug,position) values($1,$2,$3,'Synthetic',$4,1)",
        [id, o, p, id],
      );
    await c.query(
      "insert into crm_leads(id,organization_id,pipeline_id,stage_id,title) values($1,$2,$3,$4,'Synthetic')",
      [lead, org, p1, s1],
    );
    for (const stage of [s2, sf]) {
      await c.query("savepoint negative");
      await expect(
        c.query("update crm_leads set stage_id=$1 where id=$2 returning id", [stage, lead]),
      ).rejects.toMatchObject({ code: "23503" });
      await c.query("rollback to savepoint negative");
    }
    expect(
      (
        await c.query("update crm_leads set pipeline_id=$1,stage_id=$2 where id=$3 returning id", [
          p2,
          s2,
          lead,
        ])
      ).rowCount,
    ).toBe(1);
    await c.query("savepoint stage_scope");
    await expect(
      c.query("update crm_stages set pipeline_id=$1 where id=$2", [foreign, s1]),
    ).rejects.toMatchObject({ code: "23503" });
    await c.query("rollback to savepoint stage_scope");
  } finally {
    await c.query("rollback");
    c.release();
  }
});

// O update.sh reaplica o baseline SEM parar em erro, e trata todo ERROR como banco
// incompleto. Um clone com legado inconsistente atualiza sem erro e mantém as chaves
// antigas de uma coluna: a composta não casaria com as linhas legadas, e trocá-las
// deixaria apagar a etapa/funil a que elas apontam.
const BLOCO = readFileSync(
  "supabase/migrations/20261104171703_9111_integridade_organizacao_funil_etapa.sql",
  "utf8",
);
const CHAVES = [
  ["crm_stages", "crm_stages_pipeline_id_fkey"],
  ["crm_leads", "crm_leads_pipeline_id_fkey"],
  ["crm_leads", "crm_leads_stage_id_fkey"],
] as const;

async function voltaAoEstadoDeAntesDa9111(c: pg.PoolClient) {
  for (const [tabela, nome] of CHAVES)
    await c.query(`alter table ${tabela} drop constraint ${nome}`);
  await c.query(
    "alter table crm_stages add constraint crm_stages_pipeline_id_fkey foreign key(pipeline_id) references crm_pipelines(id) on delete cascade",
  );
  await c.query(
    "alter table crm_leads add constraint crm_leads_pipeline_id_fkey foreign key(pipeline_id) references crm_pipelines(id) on delete restrict",
  );
  await c.query(
    "alter table crm_leads add constraint crm_leads_stage_id_fkey foreign key(stage_id) references crm_stages(id) on delete restrict",
  );
}

async function chaves(c: pg.PoolClient) {
  const { rows } = await c.query(
    `select conname, array_length(conkey,1) as colunas, convalidated, obj_description(oid,'pg_constraint') as marker
       from pg_constraint where conname = any($1) order by conname`,
    [CHAVES.map(([, nome]) => nome)],
  );
  return rows;
}

async function semeiaLegadoInconsistente(c: pg.PoolClient) {
  const [org, p1, p2, s1, s2, sujo] = Array.from({ length: 6 }, () => randomUUID());
  await c.query(
    "insert into organizations(id,slug,legal_name,display_name) values($1,$2,'Synthetic','Synthetic')",
    [org, org],
  );
  for (const id of [p1, p2])
    await c.query(
      "insert into crm_pipelines(id,organization_id,name,slug) values($1,$2,'Synthetic',$3)",
      [id, org, id],
    );
  for (const [id, p] of [
    [s1, p1],
    [s2, p2],
  ])
    await c.query(
      "insert into crm_stages(id,organization_id,pipeline_id,name,slug,position) values($1,$2,$3,'Synthetic',$4,1)",
      [id, org, p, id],
    );
  // negócio no funil p1 com a etapa s2, que é do funil p2
  await c.query(
    "insert into crm_leads(id,organization_id,pipeline_id,stage_id,title) values($1,$2,$3,$4,'Synthetic')",
    [sujo, org, p1, s2],
  );
  return { p1, s1, s2, sujo };
}

it("clone com legado inconsistente atualiza sem erro e mantém as chaves antigas", async () => {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await voltaAoEstadoDeAntesDa9111(c);
    const { p1, s2, sujo } = await semeiaLegadoInconsistente(c);

    await c.query(BLOCO);
    await c.query(BLOCO); // o update.sh reaplica

    expect(await chaves(c)).toEqual([
      { conname: "crm_leads_pipeline_id_fkey", colunas: 1, convalidated: true, marker: null },
      { conname: "crm_leads_stage_id_fkey", colunas: 1, convalidated: true, marker: null },
      { conname: "crm_stages_pipeline_id_fkey", colunas: 1, convalidated: true, marker: null },
    ]);
    // apagar a etapa ou o funil a que o negócio legado aponta continua barrado
    for (const [sql, id] of [
      ["delete from crm_stages where id=$1", s2],
      ["delete from crm_pipelines where id=$1", p1],
    ] as const) {
      await c.query("savepoint apaga");
      await expect(c.query(sql, [id])).rejects.toMatchObject({ code: "23503" });
      await c.query("rollback to savepoint apaga");
    }
    expect(
      (await c.query("select 1 from crm_leads where id=$1 and stage_id=$2", [sujo, s2])).rowCount,
    ).toBe(1);
  } finally {
    await c.query("rollback");
    c.release();
  }
});

it("com o legado revisto, a reaplicação troca pelas chaves compostas já validadas", async () => {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await voltaAoEstadoDeAntesDa9111(c);
    const { s1, sujo } = await semeiaLegadoInconsistente(c);
    await c.query(BLOCO);
    await c.query("update crm_leads set stage_id=$1 where id=$2", [s1, sujo]);

    await c.query(BLOCO);
    await c.query(BLOCO);

    expect(await chaves(c)).toEqual([
      {
        conname: "crm_leads_pipeline_id_fkey",
        colunas: 2,
        convalidated: true,
        marker: "crm-integridade-funil-etapa-v1",
      },
      {
        conname: "crm_leads_stage_id_fkey",
        colunas: 3,
        convalidated: true,
        marker: "crm-integridade-funil-etapa-v1",
      },
      {
        conname: "crm_stages_pipeline_id_fkey",
        colunas: 2,
        convalidated: true,
        marker: "crm-integridade-funil-etapa-v1",
      },
    ]);
  } finally {
    await c.query("rollback");
    c.release();
  }
});
