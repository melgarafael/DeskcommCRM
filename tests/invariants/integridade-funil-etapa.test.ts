import { randomUUID } from "node:crypto";
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
        "insert into organizations(id,slug,legal_name,display_name) values($1,$1,'Synthetic','Synthetic')",
        [id],
      );
    for (const [id, o] of [
      [p1, org],
      [p2, org],
      [foreign, other],
    ])
      await c.query(
        "insert into crm_pipelines(id,organization_id,name,slug) values($1,$2,'Synthetic',$1)",
        [id, o],
      );
    for (const [id, o, p] of [
      [s1, org, p1],
      [s2, org, p2],
      [sf, other, foreign],
    ])
      await c.query(
        "insert into crm_stages(id,organization_id,pipeline_id,name,slug,position) values($1,$2,$3,'Synthetic',$1,1)",
        [id, o, p],
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
