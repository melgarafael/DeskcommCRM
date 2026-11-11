import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * EDITAR O TÍTULO DE UM COMPROMISSO QUE JÁ EXISTE (#3776).
 *
 * ─── O defeito, medido na main 2b7c7269d ────────────────────────────────────
 *
 * A criação com texto livre já existia (#3766), e a EDIÇÃO não: `alterarSchema`
 * na rota não tinha `title`, e a `fn_appointment_change_core` aplica `p_patch`
 * por LISTA FECHADA — sem `title`. Consertar só a rota daria 200 sem mudar
 * nada; consertar só a RPC daria 400 na porta. Este arquivo mede a segunda
 * metade: a RPC, em Postgres de verdade, com o `title` na lista.
 *
 * ─── O que ele prende, e por que cada caso existe ──────────────────────────
 *
 * 1. IDA E VOLTA: cria com título livre (insert), altera pela RPC de verdade e
 *    LÊ DE VOLTA no banco — o mesmo caminho que a grade percorre (a tela lê
 *    `calendar_appointments.title`). Um `select` que não acha o valor novo é a
 *    prova que o `200` sozinho nunca deu.
 * 2. `revision` NÃO sobe: `title` é conteúdo, como `notes`/`guest_email`, e não
 *    o COMBINADO (`starts_at`/`ends_at`/`status`). Se subisse, o CAS da tela
 *    passaria a recusar a edição seguinte de quem só mexeu no título.
 * 3. O CARIMBO DO GOOGLE sobe: `google_local_revision` incrementa quando
 *    `fn_google_projection_stamp` vê mudança de `title`, e é isso que faz o
 *    sincronizador reempurrar o evento em vez de reverter a edição local.
 * 4. VAZIO/NULO É RECUSA NOMEADA (`appointment_title_empty`), e o título
 *    anterior continua no lugar — nunca uma violação de `not null` em inglês,
 *    nunca um no-op silencioso.
 * 5. AUSENTE NÃO MEXE: `patch` sem a chave preserva o título (o `?` do jsonb
 *    distingue "não mandou" de "mandou vazio").
 * 6. O CAS SEGUE DE PÉ: patch de título com `revision` velha é `PT409`, e o
 *    título NÃO é alterado.
 *
 * ─── Baseline, não migrations ──────────────────────────────────────────────
 *
 * O `test:db` aplica SÓ `supabase/baseline.sql` (install + update). Este arquivo
 * mede o espelho do apêndice, que é o que uma instalação nova executa — e é
 * também a sabotagem honesta do PR: tirar a linha do `title` do bloco do
 * baseline deixa o caso 1 vermelho.
 */

const pool = new pg.Pool({
  connectionString:
    process.env.TEST_DATABASE_URL ??
    `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
});

const org = randomUUID();
const manager = randomUUID();
const contact = randomUUID();

/** O título LIVRE da criação, com acento e espaço — o que a tela digita. */
const TITULO_DA_CRIACAO = "  Avaliação inicial — texto livre  ";
const TITULO_NOVO = "Consulta de retorno";

async function comUsuario<T>(user: string, run: (db: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ sub: user, role: "authenticated", aal: "aal1" }),
    ]);
    return await run(client);
  } finally {
    await client.query("rollback");
    client.release();
  }
}

/** Um compromisso de hoje à frente: desfecho não entra, só o título. */
async function compromisso(titulo = TITULO_DA_CRIACAO): Promise<string> {
  const id = randomUUID();
  const inicio = new Date(Date.now() + 3 * 3_600_000);
  await pool.query(
    "insert into calendar_appointments(id,organization_id,contact_id,owner_user_id,title,starts_at,ends_at,status,time_zone) values($1,$2,$3,$4,$5,$6,$7,'confirmed','America/Sao_Paulo')",
    [id, org, contact, manager, titulo, inicio, new Date(inicio.getTime() + 3_600_000)],
  );
  return id;
}

beforeAll(async () => {
  await pool.query(
    "insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Título do compromisso','Título do compromisso')",
    [org],
  );
  await pool.query("insert into auth.users(id,email) values($1,$2)", [
    manager,
    `${manager}@invariant.test`,
  ]);
  await pool.query(
    "insert into user_organizations(organization_id,user_id,role,accepted_at) values($1,$2,'manager',now())",
    [org, manager],
  );
  await pool.query("insert into contacts(id,organization_id,display_name) values($1,$2,'Fictício')", [
    contact,
    org,
  ]);
});
afterAll(() => pool.end());

describe("o título do compromisso é editável pela RPC de transição (#3776)", () => {
  it("ida e volta: cria com texto livre, altera, e o banco devolve o título NOVO", async () => {
    const id = await compromisso();
    const antes = await pool.query("select title, revision, google_local_revision from calendar_appointments where id=$1", [id]);
    // A criação não é o objeto deste teste, mas sem ela "alterar" não teria de onde partir.
    expect(antes.rows[0].title).toBe(TITULO_DA_CRIACAO);

    const depois = await comUsuario(manager, async (db) => {
      const r = (await db.query("select fn_appointment_change($1,$2,$3,$4) r", [org, id, 1, { title: TITULO_NOVO }])).rows[0].r;
      const lido = await db.query("select title from calendar_appointments where id=$1", [id]);
      return { r, lido: lido.rows[0].title };
    });

    // O retorno da RPC e a LINHA GRAVADA — as duas pontas, não só o `200`.
    expect(depois.r.title).toBe(TITULO_NOVO);
    expect(depois.lido).toBe(TITULO_NOVO);
    // Conteúdo não mexe no COMBINADO: a revisão que o CAS compara fica parada…
    expect(Number(depois.r.revision)).toBe(1);
    // …e a revisão que o Google compara ANDA, senão a edição local sumiria na
    // próxima sincronização.
    expect(Number(depois.r.google_local_revision)).toBeGreaterThan(Number(antes.rows[0].google_local_revision));
  });

  it("`title` com espaços nas pontas é aparado — a grade não desenha o respiro", async () => {
    const id = await compromisso();
    const r = await comUsuario(
      manager,
      async (db) => (await db.query("select fn_appointment_change($1,$2,1,$3) r", [org, id, { title: "   Retorno   " }])).rows[0].r,
    );
    expect(r.title).toBe("Retorno");
  });

  it("patch SEM `title` preserva o título — ausente não é vazio", async () => {
    const id = await compromisso("Título que ninguém tocou");
    const r = await comUsuario(
      manager,
      async (db) => (await db.query("select fn_appointment_change($1,$2,1,$3) r", [org, id, { notes: "anotação interna" }])).rows[0].r,
    );
    expect(r.title).toBe("Título que ninguém tocou");
    expect(r.notes).toBe("anotação interna");
  });

  it("título vazio é RECUSA NOMEADA, e o título anterior continua gravado", async () => {
    const id = await compromisso("Título original");
    for (const vazio of ["", "   ", null]) {
      await expect(
        comUsuario(manager, async (db) => {
          await db.query("select fn_appointment_change($1,$2,1,$3)", [org, id, { title: vazio }]);
        }),
      ).rejects.toMatchObject({ code: "22023", message: expect.stringContaining("appointment_title_empty") });
    }
    const lido = await pool.query("select title from calendar_appointments where id=$1", [id]);
    expect(lido.rows[0].title).toBe("Título original");
  });

  it("CAS intacto: patch de título com `revision` velha é PT409, e nada muda", async () => {
    const id = await compromisso("Título sob CAS");
    await expect(
      comUsuario(manager, async (db) => {
        await db.query("select fn_appointment_change($1,$2,7,$3)", [org, id, { title: "Não deve entrar" }]);
      }),
    ).rejects.toMatchObject({ code: "PT409" });
    const lido = await pool.query("select title from calendar_appointments where id=$1", [id]);
    expect(lido.rows[0].title).toBe("Título sob CAS");
  });
});
