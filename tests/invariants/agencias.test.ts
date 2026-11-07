import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeEach, afterEach, describe, expect, it } from "vitest";
const pool = new pg.Pool({
  connectionString:
    process.env.AGENCIA_TEST_DB_URL ??
    `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 3,
});
let db: pg.PoolClient;
let persistido = false;
let ator: string, sessao: string, agencia: string, cliente: string, outra: string;
beforeEach(async () => {
  persistido = false;
  db = await pool.connect();
  await db.query("begin");
  [ator, sessao, agencia, cliente, outra] = Array.from({ length: 5 }, () => randomUUID()) as [
    string,
    string,
    string,
    string,
    string,
  ];
  await db.query("insert into auth.users(id,email) values($1,$2)", [
    ator,
    `qa-${ator}@invariant.test`,
  ]);
  await db.query("insert into auth.sessions(id,user_id,aal) values($1,$2,'aal1')", [sessao, ator]);
  for (const id of [agencia, cliente, outra])
    await db.query(
      "insert into organizations(id,slug,display_name,legal_name,status) values($1,$2,'Agencia QA','Agencia QA','active')",
      [id, `qa-${id}`],
    );
  await db.query(
    "insert into user_organizations(organization_id,user_id,role,accepted_at) values($1,$2,'admin',now())",
    [agencia, ator],
  );
  await db.query(
    "insert into agencia_configuracoes(organization_id,habilitada,limite_clientes) values($1,true,2)",
    [agencia],
  );
  await db.query("insert into agencia_clientes(organization_id,agencia_id) values($1,$2)", [
    cliente,
    agencia,
  ]);
  await db.query(
    "insert into contacts(organization_id,name) values($1,'Cliente autorizado'),($2,'Cliente alheio')",
    [cliente, outra],
  );
  await db.query("select set_config('request.jwt.claims',$1,true)", [
    JSON.stringify({ sub: ator, session_id: sessao, aal: "aal1" }),
  ]);
});
afterEach(async () => {
  try {
    await db.query("rollback");
    if (persistido) {
      await db.query("begin");
      const criados = (
        await db.query(
          "delete from agencia_criacoes where organization_id=$1 returning cliente_id",
          [agencia],
        )
      ).rows.map((r: { cliente_id: string }) => r.cliente_id);
      await db.query("delete from agencia_sessoes where agencia_id=$1", [agencia]);
      await db.query("delete from agencia_clientes where agencia_id=$1", [agencia]);
      await db.query("delete from organizations where id=any($1::uuid[])", [
        [agencia, cliente, outra, ...criados],
      ]);
      await db.query("delete from auth.sessions where user_id=$1", [ator]);
      await db.query("delete from auth.users where id=$1", [ator]);
      await db.query("commit");
    }
  } finally {
    await db.query("rollback");
    db.release();
  }
});
afterAll(async () => {
  await pool.end();
});
async function abrir() {
  await db.query("set local role authenticated");
  await db.query("select fn_agencia_abrir_cliente($1,$2)", [agencia, cliente]);
}
async function negado(sql: string, args: unknown[]) {
  await db.query("savepoint tentativa");
  await expect(db.query(sql, args)).rejects.toMatchObject({ code: "42501" });
  await db.query("rollback to savepoint tentativa");
}
describe("agências: autorização real no banco", () => {
  it("edita dados do cliente aberto e não altera outra organização", async () => {
    await abrir();
    expect(
      (
        await db.query(
          "update contacts set name='Editado pela agência' where organization_id=$1 returning id",
          [cliente],
        )
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await db.query(
          "update contacts set name='Alteração indevida' where organization_id=$1 returning id",
          [outra],
        )
      ).rowCount,
    ).toBe(0);
  });
  it("sessão delegada vencida perde leitura mesmo com a agência habilitada", async () => {
    await abrir();
    await db.query("reset role");
    await db.query(
      "update agencia_sessoes set expires_at=now()-interval '1 second' where agencia_id=$1 and actor_user_id=$2",
      [agencia, ator],
    );
    await db.query("set local role authenticated");
    expect((await db.query("select fn_support_context() c")).rows[0].c.status).toBe("expired");
    expect(
      (await db.query("select count(*)::int n from contacts where organization_id=$1", [cliente]))
        .rows[0].n,
    ).toBe(0);
  });

  it("sessão Auth expirada não pode criar cliente mesmo com JWT ainda não vencido", async () => {
    await db.query("update auth.sessions set not_after=now()-interval '1 second' where id=$1", [
      sessao,
    ]);
    await db.query("set local role authenticated");
    await negado("select fn_agencia_criar_cliente($1,$2,$3,$4)", [
      agencia,
      randomUUID(),
      "Cliente recusado",
      `qa-${randomUUID()}`,
    ]);
  });
  it("cliente não lê agência nem organização irmã sem vínculo direto", async () => {
    const pessoa = randomUUID();
    await db.query("insert into auth.users(id,email) values($1,$2)", [
      pessoa,
      `qa-${pessoa}@invariant.test`,
    ]);
    await db.query(
      "insert into user_organizations(organization_id,user_id,role,accepted_at) values($1,$2,'admin',now())",
      [cliente, pessoa],
    );
    await db.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ sub: pessoa, aal: "aal1" }),
    ]);
    await db.query("set local role authenticated");
    expect(
      (
        await db.query("select count(*)::int n from organizations where id=any($1::uuid[])", [
          [agencia, outra],
        ])
      ).rows[0].n,
    ).toBe(0);
    expect((await db.query("select count(*)::int n from agencia_clientes")).rows[0].n).toBe(0);
  });

  it("callback perde autorização depois da revogação e do encerramento", async () => {
    await abrir();
    await db.query("reset role");
    const permitido = async () =>
      (
        await db.query("select fn_support_callback_write_allowed($1,$2,$3) ok", [
          cliente,
          ator,
          sessao,
        ])
      ).rows[0].ok;
    expect(await permitido()).toBe(true);
    await db.query("update agencia_configuracoes set habilitada=false where organization_id=$1", [
      agencia,
    ]);
    expect(await permitido()).toBe(false);
    await db.query("select fn_agencia_encerrar_sessao()");
    expect(await permitido()).toBe(false);
  });
  it("callback usa vínculo direto admin após sair, sem reutilizar autoridade da agência", async () => {
    await db.query(
      "insert into user_organizations(organization_id,user_id,role,accepted_at) values($1,$2,'admin',now())",
      [cliente, ator],
    );
    await abrir();
    await db.query("reset role");
    await db.query("select fn_agencia_encerrar_sessao()");
    await db.query("update agencia_configuracoes set habilitada=false where organization_id=$1", [
      agencia,
    ]);
    expect(
      (
        await db.query("select fn_support_callback_write_allowed($1,$2,$3) ok", [
          cliente,
          ator,
          sessao,
        ])
      ).rows[0].ok,
    ).toBe(true);
  });

  it("duas criações simultâneas disputam a última vaga sem ultrapassar a cota", async () => {
    await db.query(
      "update agencia_configuracoes set clientes_inclusos=true where organization_id=$1",
      [agencia],
    );
    // Fixtures aleatórias ficam visíveis às duas conexões; afterEach remove só estas linhas.
    await db.query("commit");
    persistido = true;
    let prontos = 0;
    let liberar!: () => void;
    const barreira = new Promise<void>((resolve) => {
      liberar = resolve;
    });
    async function criar() {
      const conexao = await pool.connect();
      try {
        await conexao.query("begin");
        await conexao.query("select set_config('request.jwt.claims',$1,true)", [
          JSON.stringify({ sub: ator, session_id: sessao, aal: "aal1" }),
        ]);
        await conexao.query("set local role authenticated");
        if (++prontos === 2) liberar();
        await barreira;
        const resultado = await conexao.query("select fn_agencia_criar_cliente($1,$2,$3,$4) r", [
          agencia,
          randomUUID(),
          "Cliente concorrente",
          `qa-${randomUUID()}`,
        ]);
        await conexao.query("commit");
        return resultado.rows[0].r;
      } catch (error) {
        await conexao.query("rollback");
        throw error;
      } finally {
        conexao.release();
      }
    }
    const resultados = await Promise.allSettled([criar(), criar()]);
    expect(resultados.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejeitado = resultados.find((r) => r.status === "rejected");
    expect(rejeitado?.status === "rejected" && rejeitado.reason).toMatchObject({
      code: "23514",
      message: "agencia_limite_atingido",
    });
    expect(
      (
        await db.query("select count(*)::int n from agencia_clientes where agencia_id=$1", [
          agencia,
        ])
      ).rows[0].n,
    ).toBe(2);
  });

  it("inclui cliente no acordo autorizado, preserva ator e repete a criação sem duplicar", async () => {
    await db.query(
      "update agencia_configuracoes set clientes_inclusos=true where organization_id=$1",
      [agencia],
    );
    const chave = randomUUID();
    await db.query("set local role authenticated");
    const args = [agencia, chave, "Cliente criado", `qa-${randomUUID()}`];
    const primeiro = (await db.query("select fn_agencia_criar_cliente($1,$2,$3,$4) r", args))
      .rows[0].r;
    const repetido = (await db.query("select fn_agencia_criar_cliente($1,$2,$3,$4) r", args))
      .rows[0].r;
    expect(primeiro.created).toBe(true);
    expect(repetido).toEqual({ id: primeiro.id, created: false });
    await db.query("reset role");
    expect(
      (await db.query("select created_by from organizations where id=$1", [primeiro.id])).rows[0]
        .created_by,
    ).toBe(ator);
    expect(
      (
        await db.query(
          "select count(*)::int n from cobranca_assinaturas where organization_id=$1",
          [primeiro.id],
        )
      ).rows[0].n,
    ).toBe(0);
  });
  it("cliente suspenso conta na cota; reduzir limite não exclui dados", async () => {
    await db.query("update organizations set status='suspended' where id=$1", [cliente]);
    await db.query("update agencia_configuracoes set limite_clientes=0 where organization_id=$1", [
      agencia,
    ]);
    await db.query("savepoint tentativa");
    await expect(
      db.query("insert into agencia_clientes(organization_id,agencia_id) values($1,$2)", [
        outra,
        agencia,
      ]),
    ).rejects.toMatchObject({ code: "23514", message: "agencia_limite_atingido" });
    await db.query("rollback to savepoint tentativa");
    expect(
      (await db.query("select count(*)::int n from organizations where id=$1", [cliente])).rows[0]
        .n,
    ).toBe(1);
  });
  it("recusa hierarquia adicional e exclusão de agência com clientes", async () => {
    await db.query("savepoint tentativa");
    await expect(
      db.query(
        "insert into agencia_configuracoes(organization_id,habilitada,limite_clientes) values($1,true,2)",
        [cliente],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await db.query("rollback to savepoint tentativa");
    await expect(
      db.query("delete from organizations where id=$1", [agencia]),
    ).rejects.toMatchObject({ code: "23503" });
    await db.query("rollback to savepoint tentativa");
  });
  it("agência não altera a própria autorização nem seu limite via PostgREST", async () => {
    await db.query("set local role authenticated");
    await negado(
      "update agencia_configuracoes set limite_clientes=10000 where organization_id=$1",
      [agencia],
    );
    await negado("insert into agencia_clientes(organization_id,agencia_id) values($1,$2)", [
      outra,
      agencia,
    ]);
  });

  it("abre cliente sem membership nem administração global e isola os dados alheios", async () => {
    await abrir();
    const r = await db.query(
      "select fn_user_role_in_org($1) papel, fn_is_platform_admin() global, fn_support_context() contexto",
      [cliente],
    );
    expect(r.rows[0].papel).toBe("admin");
    expect(r.rows[0].global).toBe(false);
    expect(r.rows[0].contexto.agency_id).toBe(agencia);
    expect(
      (await db.query("select count(*)::int n from contacts where organization_id=$1", [outra]))
        .rows[0].n,
    ).toBe(0);
    expect(
      (await db.query("select count(*)::int n from contacts where organization_id=$1", [cliente]))
        .rows[0].n,
    ).toBe(1);
    await db.query("reset role");
    expect(
      (
        await db.query(
          "select count(*)::int n from user_organizations where organization_id=$1 and user_id=$2",
          [cliente, ator],
        )
      ).rows[0].n,
    ).toBe(0);
  });
  it("recusa cliente alheio mesmo conhecendo seu UUID", async () => {
    await db.query("set local role authenticated");
    await negado("select fn_agencia_abrir_cliente($1,$2)", [agencia, outra]);
  });
  it.each(["desabilitada", "papel", "suspensa"])("revoga sessão aberta: %s", async (motivo) => {
    await abrir();
    await db.query("reset role");
    if (motivo === "desabilitada")
      await db.query("update agencia_configuracoes set habilitada=false where organization_id=$1", [
        agencia,
      ]);
    if (motivo === "papel") {
      await db.query("select set_config('request.jwt.claims','{}',true)");
      await db.query(
        "update user_organizations set role='agent' where organization_id=$1 and user_id=$2",
        [agencia, ator],
      );
      await db.query("select set_config('request.jwt.claims',$1,true)", [
        JSON.stringify({ sub: ator, session_id: sessao, aal: "aal1" }),
      ]);
    }
    if (motivo === "suspensa")
      await db.query("update organizations set status='suspended' where id=$1", [agencia]);
    await db.query("set local role authenticated");
    expect((await db.query("select fn_support_context() c")).rows[0].c.status).toBe("revoked");
    expect(
      (await db.query("select count(*)::int n from contacts where organization_id=$1", [cliente]))
        .rows[0].n,
    ).toBe(0);
    await db.query("select fn_agencia_encerrar_sessao()");
    expect((await db.query("select fn_support_context() c")).rows[0].c).toBeNull();
  });
  it("bloqueia transformar delegação em membership permanente", async () => {
    await abrir();
    await negado(
      "insert into user_organizations(organization_id,user_id,role,accepted_at) values($1,$2,'admin',now())",
      [cliente, ator],
    );
  });
  it("usuário comum da agência não recebe delegação", async () => {
    await db.query(
      "update user_organizations set role='agent' where organization_id=$1 and user_id=$2",
      [agencia, ator],
    );
    await db.query("set local role authenticated");
    await negado("select fn_agencia_abrir_cliente($1,$2)", [agencia, cliente]);
  });
  it("preserva vínculo direto legítimo depois de encerrar delegação revogada", async () => {
    await db.query(
      "insert into user_organizations(organization_id,user_id,role,accepted_at) values($1,$2,'viewer',now())",
      [cliente, ator],
    );
    await abrir();
    await db.query("reset role");
    await db.query("update agencia_configuracoes set habilitada=false where organization_id=$1", [
      agencia,
    ]);
    await db.query("set local role authenticated");
    await db.query("select fn_agencia_encerrar_sessao()");
    expect((await db.query("select fn_user_role_in_org($1) papel", [cliente])).rows[0].papel).toBe(
      "viewer",
    );
  });
});
