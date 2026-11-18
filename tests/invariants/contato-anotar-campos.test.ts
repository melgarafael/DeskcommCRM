/**
 * `fn_contato_anotar_campos` (migration 9398) — o diagnóstico que o agente grava
 * na ficha não apaga os outros campos do contato.
 *
 * O teste unitário (`tests/unit/diagnostico-pela-ia.test.tsx`) prova o handler
 * sobre um banco falso. Este prova o que só o Postgres prova:
 *
 *  - a segunda gravação ESPERA a primeira e soma sobre ela (READ COMMITTED);
 *  - só as chaves pedidas mudam, `p_remover` sai na mesma instrução;
 *  - contato de outra organização e ficha anonimizada devolvem nulo e ficam
 *    intactos — inclusive a anonimização que confirma ANTES da gravação;
 *  - só `service_role` executa (as duas origens de EXECUTE revogadas).
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
  const contato = randomUUID();
  await pool.query(
    "insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Diagnóstico','Diagnóstico')",
    [org],
  );
  await pool.query(
    "insert into contacts(id,organization_id,display_name,custom_fields) values($1,$2,'Padaria',$3)",
    [contato, org, customFields],
  );
  return { org, contato };
}

const anotar = "select public.fn_contato_anotar_campos($1,$2,$3::jsonb,$4::text[]) as campos";
const ler = async (contato: string) =>
  (await pool.query("select custom_fields from contacts where id=$1", [contato])).rows[0].custom_fields;

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

it("preserva os links, os campos da organização e as observações; troca só o pedido", async () => {
  const f = await fixture({
    link_instagram: "instagram.com/padaria",
    convenio: "Unimed",
    diag_observacoes: "Recado da equipe.",
    diag_resumo: "Texto antigo.",
    diag_por: "usuario:22222222-2222-4222-8222-222222222222",
    diag_em: "2026-11-01T10:00:00.000Z",
  });

  await pool.query(anotar, [
    f.org,
    f.contato,
    JSON.stringify({ diag_resumo: "Texto da IA.", segmento: "Padaria" }),
    ["diag_por", "diag_em"],
  ]);

  expect(await ler(f.contato)).toEqual({
    link_instagram: "instagram.com/padaria",
    convenio: "Unimed",
    diag_observacoes: "Recado da equipe.",
    diag_resumo: "Texto da IA.",
    segmento: "Padaria",
  });
});

it("a segunda gravação ESPERA a primeira confirmar e soma em cima dela", async () => {
  const f = await fixture({ link_site: "exemplo.com.br" });
  const a = await pool.connect();
  const b = await pool.connect();
  const observer = await pool.connect();
  const bpid = (await b.query("select pg_backend_pid() pid")).rows[0].pid;
  try {
    await a.query("begin; set local statement_timeout='10s'");
    await b.query("begin; set local statement_timeout='10s'");

    // A: o "Completar fichas" grava um link e SEGURA a linha.
    await a.query(anotar, [f.org, f.contato, JSON.stringify({ link_instagram: "instagram.com/x" }), []]);
    // B: o agente grava o diagnóstico no meio — tem de esperar, não passar por cima.
    const pendente = b.query(anotar, [f.org, f.contato, JSON.stringify({ diag_resumo: "Diagnóstico." }), []]);
    await esperandoTrava(observer, bpid);

    await a.query("commit");
    const resposta = await pendente;
    await b.query("commit");

    const esperado = { link_site: "exemplo.com.br", link_instagram: "instagram.com/x", diag_resumo: "Diagnóstico." };
    expect(resposta.rows[0].campos).toEqual(esperado);
    expect(await ler(f.contato)).toEqual(esperado);
  } finally {
    await a.query("rollback").catch(() => undefined);
    await b.query("rollback").catch(() => undefined);
    a.release();
    b.release();
    observer.release();
  }
});

it("contato de OUTRA organização devolve null e não grava nada", async () => {
  const dono = await fixture({ intacto: "sim" });
  const outra = await fixture();

  const r = await pool.query(anotar, [outra.org, dono.contato, JSON.stringify({ diag_resumo: "x" }), []]);

  expect(r.rows[0].campos).toBeNull();
  expect(await ler(dono.contato)).toEqual({ intacto: "sim" });
});

it("ficha anonimizada devolve null e continua vazia", async () => {
  const f = await fixture({ diag_resumo: "Antes." });
  await pool.query("update contacts set is_anonymized=true,anonymized_at=now() where id=$1", [f.contato]);
  const depoisDaAnonimizacao = await ler(f.contato);

  const r = await pool.query(anotar, [f.org, f.contato, JSON.stringify({ diag_resumo: "Depois." }), []]);

  expect(r.rows[0].campos).toBeNull();
  expect(await ler(f.contato)).toEqual(depoisDaAnonimizacao);
});

it("anonimização que confirma ANTES: a gravação que esperava não traz o dado de volta", async () => {
  const f = await fixture({ diag_resumo: "Antes." });
  const a = await pool.connect();
  const b = await pool.connect();
  const observer = await pool.connect();
  const bpid = (await b.query("select pg_backend_pid() pid")).rows[0].pid;
  try {
    await a.query("begin; set local statement_timeout='10s'");
    await b.query("begin; set local statement_timeout='10s'");

    await a.query("update contacts set is_anonymized=true,anonymized_at=now() where id=$1", [f.contato]);
    const pendente = b.query(anotar, [f.org, f.contato, JSON.stringify({ diag_resumo: "Depois." }), []]);
    await esperandoTrava(observer, bpid);

    await a.query("commit");
    const resposta = await pendente;
    await b.query("commit");

    expect(resposta.rows[0].campos).toBeNull();
    expect(await ler(f.contato)).not.toHaveProperty("diag_resumo", "Depois.");
  } finally {
    await a.query("rollback").catch(() => undefined);
    await b.query("rollback").catch(() => undefined);
    a.release();
    b.release();
    observer.release();
  }
});

it("recusa quem não manda um objeto", async () => {
  const f = await fixture();

  for (const invalido of ["[1,2]", '"texto"', "null"]) {
    await expect(pool.query(anotar, [f.org, f.contato, invalido, []])).rejects.toMatchObject({ code: "22023" });
  }
  expect(await ler(f.contato)).toEqual({});
});

it("nem anon nem authenticated executam a função — só service_role", async () => {
  const f = await fixture();

  for (const papel of ["anon", "authenticated"]) {
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query(`set local role ${papel}`);
      await expect(c.query(anotar, [f.org, f.contato, "{}", []])).rejects.toMatchObject({ code: "42501" });
    } finally {
      await c.query("rollback");
      c.release();
    }
  }
});
