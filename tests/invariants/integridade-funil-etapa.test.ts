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
// incompleto. Um clone com legado inconsistente não pode receber esse aviso a cada
// atualização: as chaves entram NOT VALID (valem para gravação nova) e só o legado
// fica sem validar.
it("clone com legado inconsistente atualiza sem erro e já recusa gravação nova", async () => {
  const c = await pool.connect();
  const [org, p1, p2, s1, s2, sujo, novo] = Array.from({ length: 7 }, () => randomUUID());
  const bloco = readFileSync(
    "supabase/migrations/20261104171703_9111_integridade_organizacao_funil_etapa.sql",
    "utf8",
  );
  try {
    await c.query("begin");
    // O estado de antes da 9111: a chave da etapa conferia só o id.
    await c.query("alter table crm_leads drop constraint crm_leads_stage_id_fkey");
    await c.query(
      "alter table crm_leads add constraint crm_leads_stage_id_fkey foreign key(stage_id) references crm_stages(id) on delete restrict",
    );
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
    await c.query(
      "insert into crm_leads(id,organization_id,pipeline_id,stage_id,title) values($1,$2,$3,$4,'Synthetic')",
      [sujo, org, p1, s2],
    );

    await c.query(bloco);

    const { rows } = await c.query(
      "select convalidated, obj_description(oid,'pg_constraint') as marker from pg_constraint where conrelid='public.crm_leads'::regclass and conname='crm_leads_stage_id_fkey'",
    );
    expect(rows).toEqual([{ convalidated: false, marker: "crm-integridade-funil-etapa-v1" }]);
    await c.query("savepoint nova");
    await expect(
      c.query(
        "insert into crm_leads(id,organization_id,pipeline_id,stage_id,title) values($1,$2,$3,$4,'Synthetic')",
        [novo, org, p1, s2],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await c.query("rollback to savepoint nova");
    expect(
      (await c.query("select 1 from crm_leads where id=$1 and stage_id=$2", [sujo, s2])).rowCount,
    ).toBe(1);
  } finally {
    await c.query("rollback");
    c.release();
  }
});
