import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

if (!process.env.TEST_DB_CONTAINER) throw new Error("Rode por pnpm test:db, no banco efêmero da suíte.");
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? "54329"}/postgres`,
  max: 2,
});
const orgA = randomUUID();
const orgB = randomUUID();
const viewerA = randomUUID();
const viewerB = randomUUID();
const managerA = randomUUID();
const leadA = randomUUID();
const leadB = randomUUID();
const propostaA = randomUUID();
const propostaB = randomUUID();

beforeAll(async () => {
  for (const [org, viewer, lead, proposta] of [
    [orgA, viewerA, leadA, propostaA], [orgB, viewerB, leadB, propostaB],
  ] as const) {
    const funil = randomUUID();
    const etapa = randomUUID();
    await pool.query(`insert into public.organizations (id,slug,legal_name,display_name)
      values ($1,$2,'Organização sintética','Prova de isolamento')`, [org, `propostas-${org}`]);
    await pool.query("insert into auth.users (id,email) values ($1,$2)", [viewer, `${viewer}@invariant.test`]);
    await pool.query(`insert into public.user_organizations (user_id,organization_id,role,accepted_at)
      values ($1,$2,'viewer',now())`, [viewer, org]);
    await pool.query(`insert into public.crm_pipelines (id,organization_id,name,slug)
      values ($1,$2,'Funil sintético','propostas-rls')`, [funil, org]);
    await pool.query(`insert into public.crm_stages (id,organization_id,pipeline_id,name,slug,position)
      values ($1,$2,$3,'Entrada','entrada',1000)`, [etapa, org, funil]);
    await pool.query(`insert into public.crm_leads (id,organization_id,pipeline_id,stage_id,title)
      values ($1,$2,$3,$4,'Negócio sintético')`, [lead, org, funil, etapa]);
    await pool.query(`insert into public.lead_field_proposals
      (id,organization_id,lead_id,campo,valor_proposto,trecho,expires_at)
      values ($1,$2,$3,'medida','1.234'::jsonb,'Trecho sintético',now()+interval '7 days')`,
    [proposta, org, lead]);
  }
  await pool.query("insert into auth.users (id,email) values ($1,$2)", [managerA, `${managerA}@invariant.test`]);
  await pool.query(`insert into public.user_organizations (user_id,organization_id,role,accepted_at)
    values ($1,$2,'manager',now())`, [managerA, orgA]);
});

afterAll(async () => { await pool.end(); });

/** Uma sessão autenticada real; rollback mantém a mesma precondição entre casos. */
async function como<T>(usuario: string, executar: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: usuario, aal: "aal1" })]);
    return await executar(client);
  } finally {
    await client.query("rollback");
    client.release();
  }
}

describe("fila do card: RLS e papéis no Postgres real", () => {
  it.each([[viewerA, propostaA, propostaB], [viewerB, propostaB, propostaA]] as const)(
    "%s lê a própria linha e não lê a do outro tenant", async (usuario, propria, alheia) => {
      await como(usuario, async (client) => {
        const { rows } = await client.query("select id from public.lead_field_proposals where id=any($1::uuid[])", [[propria, alheia]]);
        expect(rows.map((r: { id: string }) => r.id)).toEqual([propria]);
      });
    },
  );

  it("viewer não decide nem pelo acesso direto ao PostgREST", async () => {
    await como(viewerA, async (client) => {
      const r = await client.query(`update public.lead_field_proposals
        set status='dismissed',decided_at=now() where id=$1`, [propostaA]);
      expect(r.rowCount).toBe(0);
    });
  });

  it("manager decide a própria proposta — controle positivo da escrita", async () => {
    await como(managerA, async (client) => {
      const r = await client.query(`update public.lead_field_proposals
        set status='dismissed',decided_at=now() where id=$1 returning id`, [propostaA]);
      expect(r.rows).toEqual([{ id: propostaA }]);
    });
  });

  it("manager não decide a proposta de outra organização", async () => {
    await como(managerA, async (client) => {
      const r = await client.query(`update public.lead_field_proposals
        set status='dismissed',decided_at=now() where id=$1`, [propostaB]);
      expect(r.rowCount).toBe(0);
    });
  });

  it("INSERT sem RETURNING não pode ligar a organização própria ao negócio alheio", async () => {
    await como(managerA, async (client) => {
      let negado = false;
      try {
        // Sem RETURNING: pedir SELECT de uma linha invisível acrescentaria uma
        // segunda cerca e esconderia a ausência do vínculo no WITH CHECK.
        await client.query(`insert into public.lead_field_proposals
          (organization_id,lead_id,campo,trecho,expires_at)
          values ($1,$2,'campo_cruzado','Trecho sintético',now()+interval '7 days')`, [orgA, leadB]);
      } catch (err) {
        expect(["42501", "23503", "23514"]).toContain((err as { code?: string }).code);
        negado = true;
      }
      expect(negado, "a RLS/FK aceitou orgA com o negócio de orgB").toBe(true);
    });
  });
});
