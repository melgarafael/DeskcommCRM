import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, expect, it } from "vitest";

const banco = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
});
afterAll(() => banco.end());

async function cenario() {
  const org = randomUUID();
  const origem = randomUUID();
  const destino = randomUUID();
  const etapaDaOrigem = randomUUID();
  const etapaDoDestino = randomUUID();
  const etapaDePerda = randomUUID();
  const lead = randomUUID();

  await banco.query(
    "insert into public.organizations (id, slug, legal_name, display_name) values ($1::uuid, $1::text, 'Clonagem', 'Clonagem')",
    [org],
  );
  await banco.query(
    `insert into public.crm_pipelines (id, organization_id, name, slug)
     values ($1, $3, 'Vendas', 'vendas'), ($2, $3, 'Pós-venda', 'pos-venda')`,
    [origem, destino, org],
  );
  await banco.query(
    `insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position, is_lost)
     values ($1, $5, $3, 'Aberto', 'aberto', 1000, false),
            ($2, $5, $4, 'Entrada', 'entrada', 1000, false),
            ($6, $5, $3, 'Perda', 'perda', 2000, true)`,
    [etapaDaOrigem, etapaDoDestino, origem, destino, org, etapaDePerda],
  );
  await banco.query(
    `insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title)
     values ($1, $2, $3, $4, 'Negócio de origem')`,
    [lead, org, origem, etapaDaOrigem],
  );
  return { org, origem, destino, etapaDaOrigem, etapaDoDestino, etapaDePerda, lead };
}

type Cenario = Awaited<ReturnType<typeof cenario>>;

// Passos SQL do /clone anterior à guarda: a sessão insere o clone e o
// servidor grava o vínculo em seguida, sem consulta de continuação.
async function clonar(conn: pg.Pool | pg.PoolClient, c: Cenario): Promise<string> {
  const resultado = await conn.query<{ id: string }>(
    `insert into public.crm_leads (organization_id, pipeline_id, stage_id, title)
     values ($1, $2, $3, 'Negócio clonado') returning id`,
    [c.org, c.destino, c.etapaDoDestino],
  );
  const id = resultado.rows[0]!.id;
  await conn.query(
    `update public.crm_leads set source_metadata = $1 where id = $2`,
    [{ clonado_de: { lead_id: c.lead, pipeline_id: c.origem } }, id],
  );
  return id;
}

async function idsNoDestino(c: Cenario) {
  const resultado = await banco.query<{ id: string }>(
    "select id from public.crm_leads where organization_id = $1 and pipeline_id = $2 order by id",
    [c.org, c.destino],
  );
  return resultado.rows.map(({ id }) => id);
}

it("repetição: devolve o id da mesma cópia e deixa um único card no destino", async () => {
  const c = await cenario();
  const primeira = await clonar(banco, c);
  const segunda = await clonar(banco, c);
  expect({ segunda, ids: await idsNoDestino(c) }).toEqual({ segunda: primeira, ids: [primeira] });
});

it("corrida: dois backends de Postgres recebem o mesmo id e deixam um único card", async () => {
  const c = await cenario();
  const a = await banco.connect();
  const b = await banco.connect();
  const pid = (await b.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
  let segunda: Promise<string> | undefined;
  try {
    await a.query("begin; set local statement_timeout = '15s'");
    await b.query("begin; set local statement_timeout = '15s'");
    const idA = await clonar(a, c);
    let terminou = false;
    segunda = clonar(b, c).finally(() => { terminou = true; });
    // O backend B já está tentando a escrita enquanto A segura a transação.
    // Sem a guarda B chega ao fim e insere, em vez de esperar o commit de A.
    await expect.poll(async () => {
      const r = await banco.query<{ aguardando: boolean }>(
        "select wait_event_type = 'Lock' as aguardando from pg_stat_activity where pid = $1",
        [pid],
      );
      return terminou || r.rows[0]?.aguardando === true;
    }).toBe(true);
    await a.query("commit");
    const idB = await segunda;
    await b.query("commit");
    expect({ idB, ids: await idsNoDestino(c) }).toEqual({ idB: idA, ids: [idA] });
  } finally {
    await a.query("rollback");
    await segunda?.catch(() => undefined);
    await b.query("rollback");
    a.release();
    b.release();
  }
});
