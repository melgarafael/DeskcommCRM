/**
 * Duas anotações ao mesmo tempo no mesmo negócio NÃO se apagam (migration 0502).
 *
 * O teste unitário do handler reproduz a corrida com um banco falso. Este é o
 * que prova a espera entre transações DE VERDADE, num Postgres real: duas transações abertas, a
 * segunda chamando `fn_lead_anotar_campos` ENQUANTO a primeira ainda não
 * confirmou. A segunda tem de ESPERAR a linha, recalcular sobre o que a primeira
 * gravou e somar. Se o valor fosse calculado FORA do UPDATE (ler e gravar depois), as duas concatenariam em cima da mesma versão
 * velha e a última venceria sozinha.
 *
 * Roda só no CI e em `pnpm test:db` (precisa de Postgres).
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, expect, it } from "vitest";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 5,
});
afterAll(() => pool.end());

async function fixture(customFields: Record<string, unknown> = {}) {
  const org = randomUUID();
  const pipeline = randomUUID();
  const stage = randomUUID();
  const lead = randomUUID();
  await pool.query(
    "insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Anotação','Anotação')",
    [org],
  );
  await pool.query(
    "insert into crm_pipelines(id,organization_id,name,slug) values($1::uuid,$2,'Funil',$1::text)",
    [pipeline, org],
  );
  await pool.query(
    "insert into crm_stages(id,organization_id,pipeline_id,name,slug,position) values($1,$2,$3,'Entrada','entrada',1)",
    [stage, org, pipeline],
  );
  await pool.query(
    "insert into crm_leads(id,organization_id,pipeline_id,stage_id,title,custom_fields) values($1,$2,$3,$4,'Negócio',$5)",
    [lead, org, pipeline, stage, customFields],
  );
  return { org, lead };
}

const anotar = "select public.fn_lead_anotar_campos($1,$2,$3::jsonb) as campos";
const ler = async (lead: string) =>
  (await pool.query("select custom_fields from crm_leads where id=$1", [lead])).rows[0].custom_fields;

async function esperandoTrava(observer: pg.PoolClient, pid: number) {
  await expect
    .poll(
      async () => {
        const r = (
          await observer.query("select wait_event_type from pg_stat_activity where pid=$1", [pid])
        ).rows[0];
        return r?.wait_event_type === "Lock";
      },
      { timeout: 5000, interval: 20 },
    )
    .toBe(true);
}

it("a segunda anotação ESPERA a primeira confirmar e soma em cima dela", async () => {
  const f = await fixture();
  const a = await pool.connect();
  const b = await pool.connect();
  const observer = await pool.connect();
  const bpid = (await b.query("select pg_backend_pid() pid")).rows[0].pid;
  try {
    await a.query("begin; set local statement_timeout='10s'");
    await b.query("begin; set local statement_timeout='10s'");

    // A anota e SEGURA a trava (não confirma ainda).
    await a.query(anotar, [f.org, f.lead, JSON.stringify({ orcamento: "5000" })]);

    // B chega no meio: tem de ficar esperando, não passar por cima.
    const pendente = b.query(anotar, [f.org, f.lead, JSON.stringify({ prazo: "30 dias" })]);
    await esperandoTrava(observer, bpid);

    await a.query("commit");
    const resposta = await pendente;
    await b.query("commit");

    // A resposta de B já traz a chave de A: ele releu depois de esperar.
    expect(resposta.rows[0].campos).toEqual({ orcamento: "5000", prazo: "30 dias" });
    expect(await ler(f.lead)).toEqual({ orcamento: "5000", prazo: "30 dias" });
  } finally {
    await a.query("rollback").catch(() => undefined);
    await b.query("rollback").catch(() => undefined);
    a.release();
    b.release();
    observer.release();
  }
});

it("preserva o que já existia e sobrescreve só a chave repetida", async () => {
  const f = await fixture({ antigo: "fica", trocado: "velho" });

  await pool.query(anotar, [f.org, f.lead, JSON.stringify({ trocado: "novo", extra: "1" })]);

  expect(await ler(f.lead)).toEqual({ antigo: "fica", trocado: "novo", extra: "1" });
});

it("lead de OUTRA organização devolve null e não grava nada", async () => {
  const dono = await fixture({ intacto: "sim" });
  const outra = await fixture();

  const r = await pool.query(anotar, [outra.org, dono.lead, JSON.stringify({ invasor: "x" })]);

  expect(r.rows[0].campos).toBeNull();
  expect(await ler(dono.lead)).toEqual({ intacto: "sim" });
});

it("recusa quem não manda um objeto", async () => {
  const f = await fixture();

  for (const invalido of ["[1,2]", '"texto"', "null"]) {
    await expect(pool.query(anotar, [f.org, f.lead, invalido])).rejects.toMatchObject({ code: "22023" });
  }
  expect(await ler(f.lead)).toEqual({});
});

it("nem anon nem authenticated executam a função — só service_role", async () => {
  const f = await fixture();

  for (const papel of ["anon", "authenticated"]) {
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query(`set local role ${papel}`);
      await expect(c.query(anotar, [f.org, f.lead, "{}"])).rejects.toMatchObject({ code: "42501" });
    } finally {
      await c.query("rollback");
      c.release();
    }
  }
});
