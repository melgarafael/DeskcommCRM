/**
 * O CATÁLOGO DE SERVIÇOS EM POSTGRES DE VERDADE (#3480, doc 212).
 *
 * O que dublê nenhum alcança: os CHECKs que não podem resultar em NULL, o
 * gatilho de vínculos entre organizações, dois tenants pela sessão (JWT), a
 * escrita atômica com a família travada, a corrida entre o sinal e o preço de
 * uma variação, e o que sobra quando o principal é apagado.
 *
 * Rodado por `pnpm test:db`: cada arquivo num banco próprio, sem módulo
 * instalado — o `beforeAll` instala chamando a provisionadora, como
 * `fn_modulo_instalar` faz.
 */
import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const pool = new pg.Pool({
  connectionString:
    process.env.TEST_DATABASE_URL ?? `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 6,
});
afterAll(() => pool.end());

const q = async (texto: string, valores: unknown[] = []) => (await pool.query(texto, valores)).rows;

async function organizacao() {
  const org = randomUUID();
  const dono = randomUUID();
  await q("insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Demonstração fictícia','Demonstração fictícia')", [org]);
  await q("insert into auth.users(id,email) values($1,$2)", [dono, `${dono}@example.test`]);
  await q("insert into user_organizations(organization_id,user_id,role,accepted_at) values($1,$2,'manager',now())", [org, dono]);
  return { org, dono };
}

async function item(org: string, preco: number) {
  const id = randomUUID();
  await q("insert into catalog_products(id,organization_id,codigo,nome,preco_cents) values($1,$2,$3,'Item fictício',$4)", [id, org, id, preco]);
  return id;
}

/** Item + detalhe de principal, gravados direto (como `postgres`), para os casos de CHECK. */
async function principal(org: string, preco = 100_000, extra: Record<string, unknown> = {}) {
  const id = await item(org, preco);
  const d = { tipo: "projeto", unidade: "valor_fechado", ...extra };
  await q(
    `insert into catalog_service_details(product_id,organization_id,${Object.keys(d).join(",")})
     values($1,$2,${Object.keys(d).map((_, i) => `$${i + 3}`).join(",")})`,
    [id, org, ...Object.values(d)],
  );
  return id;
}

const salvar = async (
  org: string,
  id: string | null,
  itemJson: Record<string, unknown>,
  detalhe: Record<string, unknown>,
  revisao: number | null = null,
  cliente: pg.Pool | pg.PoolClient = pool,
) =>
  (
    await cliente.query("select fn_catalogo_servicos_salvar($1,$2,$3,$4,$5) as r", [
      org, id, JSON.stringify(itemJson), JSON.stringify(detalhe), revisao,
    ])
  ).rows[0].r as { product_id: string; principal_id: string; revision: number };

const novoItem = (preco: number) => ({ codigo: randomUUID(), nome: "Serviço fictício", preco_cents: preco, moeda: "BRL" });

/** Roda `corpo` com a sessão de `usuario`, como o PostgREST faz. */
async function comoSessao<T>(usuario: string, corpo: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: usuario, role: "authenticated" })]);
    await c.query("set local role authenticated");
    return await corpo(c);
  } finally {
    await c.query("rollback");
    c.release();
  }
}

let a: Awaited<ReturnType<typeof organizacao>>;
let b: Awaited<ReturnType<typeof organizacao>>;

beforeAll(async () => {
  await q("select public.fn_catalogo_servicos_provisionar()");
  a = await organizacao();
  b = await organizacao();
}, 60_000);

describe("os CHECKs não resultam em NULL", () => {
  // Os três casos que a versão anterior (colunas no catálogo) aceitava,
  // reproduzidos em pg17 na triagem de 07/11.
  it("recusa prazo sem tipo, sinal fixo sem valor e sinal percentual sem percentual", async () => {
    const v = await principal(a.org);
    const varItem = await item(a.org, 50_000);
    await expect(
      q("insert into catalog_service_details(product_id,organization_id,pai_product_id,prazo_dias_uteis) values($1,$2,$3,5)", [varItem, a.org, v]),
    ).rejects.toThrow("catalog_service_details_forma_check");
    await expect(principal(a.org, 100_000, { sinal_tipo: "fixo" })).rejects.toThrow("catalog_service_details_sinal_check");
    await expect(principal(a.org, 100_000, { sinal_tipo: "percentual" })).rejects.toThrow("catalog_service_details_sinal_check");
  });

  it("recusa tipo × unidade incompatíveis, principal sem unidade e prazo fora de projeto", async () => {
    await expect(principal(a.org, 1, { tipo: "recorrente", unidade: "hora" })).rejects.toThrow("forma_check");
    await expect(principal(a.org, 1, { tipo: "projeto", unidade: null })).rejects.toThrow("forma_check");
    await expect(principal(a.org, 1, { tipo: "recorrente", unidade: "mes", prazo_dias_uteis: 5 })).rejects.toThrow("prazo_check");
  });

  it("controle positivo: o que é válido entra", async () => {
    await principal(a.org, 100_000, { tipo: "projeto", unidade: "valor_fechado", prazo_dias_uteis: 15, sinal_tipo: "percentual", sinal_percentual: 30 });
    await principal(a.org, 100_000, { tipo: "recorrente", unidade: "mes", sinal_tipo: "fixo", sinal_cents: 5_000 });
  });
});

describe("vínculos dentro da organização", () => {
  it("o detalhe não aponta para item nem principal de outra organização, e o vínculo não muda", async () => {
    const alheio = await item(b.org, 1_000);
    await expect(
      q("insert into catalog_service_details(product_id,organization_id,tipo,unidade) values($1,$2,'projeto','hora')", [alheio, a.org]),
    ).rejects.toThrow("catalogo_servicos_vinculo_invalido");

    const principalB = await principal(b.org);
    const meu = await item(a.org, 1_000);
    await expect(
      q("insert into catalog_service_details(product_id,organization_id,pai_product_id) values($1,$2,$3)", [meu, a.org, principalB]),
    ).rejects.toThrow("catalogo_servicos_vinculo_invalido");

    // Variação de variação não existe.
    const p = await principal(a.org);
    const v = (await salvar(a.org, null, novoItem(50_000), { pai_product_id: p })).product_id;
    await expect(salvar(a.org, null, novoItem(40_000), { pai_product_id: v })).rejects.toThrow("servico_principal_nao_encontrado");

    await expect(q("update catalog_service_details set pai_product_id=null where product_id=$1", [v])).rejects.toThrow(
      "catalogo_servicos_vinculo_imutavel",
    );
  });
});

describe("dois tenants pela sessão", () => {
  it("cada organização lê só os próprios detalhes, e a sessão não grava nada", async () => {
    const meu = await principal(a.org);
    const vizinho = await principal(b.org);
    await comoSessao(a.dono, async (c) => {
      const { rows } = await c.query("select product_id from catalog_service_details");
      expect(rows.map((r) => r.product_id)).toContain(meu);
      expect(rows.map((r) => r.product_id)).not.toContain(vizinho);
    });
    for (const dml of [
      `update catalog_service_details set sinal_tipo='fixo', sinal_cents=1 where product_id='${meu}'`,
      `delete from catalog_service_details where product_id='${meu}'`,
      `insert into catalog_service_details(product_id,organization_id,tipo,unidade) values('${await item(a.org, 1)}','${a.org}','projeto','hora')`,
    ]) {
      await expect(comoSessao(a.dono, (c) => c.query(dml))).rejects.toMatchObject({ code: "42501" });
    }
    // A função de escrita também não é da sessão: quem chama é o servidor.
    await expect(
      comoSessao(a.dono, (c) => c.query("select fn_catalogo_servicos_salvar($1,null,'{}','{}',null)", [a.org])),
    ).rejects.toMatchObject({ code: "42501" });
  });
});

describe("a escrita numa transação só (fn_catalogo_servicos_salvar)", () => {
  it("cria principal e variação com item e detalhe juntos, e o preço fica no item", async () => {
    const p = await salvar(a.org, null, novoItem(120_000), { tipo: "recorrente", unidade: "mes", sinal_tipo: "percentual", sinal_percentual: 30 });
    const v = await salvar(a.org, null, novoItem(190_000), { pai_product_id: p.product_id });
    expect(v.principal_id).toBe(p.product_id);
    const [linha] = await q(
      "select p.preco_cents, p.controla_estoque, d.pai_product_id from catalog_products p join catalog_service_details d on d.product_id=p.id where p.id=$1",
      [v.product_id],
    );
    expect(linha).toMatchObject({ preco_cents: "190000", controla_estoque: false, pai_product_id: p.product_id });
  });

  it("sinal fixo acima do menor preço da família é recusado em TODA escrita do módulo, e nada fica gravado", async () => {
    const p = await salvar(a.org, null, novoItem(100_000), { tipo: "projeto", unidade: "valor_fechado", sinal_tipo: "fixo", sinal_cents: 30_000 });
    // POST de principal com sinal acima do próprio preço.
    await expect(
      salvar(a.org, null, novoItem(20_000), { tipo: "projeto", unidade: "hora", sinal_tipo: "fixo", sinal_cents: 30_000 }),
    ).rejects.toThrow("servico_sinal_acima_do_preco");
    // POST de variação mais barata que o sinal: nem o item nasce.
    const codigo = randomUUID();
    await expect(
      salvar(a.org, null, { ...novoItem(29_999), codigo }, { pai_product_id: p.product_id }),
    ).rejects.toThrow("servico_sinal_acima_do_preco");
    expect(await q("select 1 from catalog_products where organization_id=$1 and codigo=$2", [a.org, codigo])).toHaveLength(0);
    // PATCH de variação que baixa o preço.
    const v = await salvar(a.org, null, novoItem(50_000), { pai_product_id: p.product_id });
    await expect(salvar(a.org, v.product_id, { preco_cents: 10_000 }, {}, v.revision)).rejects.toThrow("servico_sinal_acima_do_preco");
    // PATCH do principal que sobe o sinal.
    await expect(salvar(a.org, p.product_id, {}, { sinal_tipo: "fixo", sinal_cents: 60_000 }, p.revision)).rejects.toThrow(
      "servico_sinal_acima_do_preco",
    );
    // Controle positivo: igual ao menor preço passa.
    await salvar(a.org, p.product_id, {}, { sinal_tipo: "fixo", sinal_cents: 50_000 }, p.revision);
  });

  it("revisão velha = PT409, e a revisão só cresce", async () => {
    const p = await salvar(a.org, null, novoItem(1_000), { tipo: "hora_marcada", unidade: "sessao" });
    const depois = await salvar(a.org, p.product_id, { nome: "Outro nome" }, {}, p.revision);
    expect(depois.revision).toBe(p.revision + 1);
    await expect(salvar(a.org, p.product_id, { nome: "Atropelo" }, {}, p.revision)).rejects.toMatchObject({ code: "PT409" });
  });

  it("código repetido derruba a escrita inteira: nenhum detalhe órfão", async () => {
    const existente = await item(a.org, 1_000);
    const [{ codigo }] = await q("select codigo from catalog_products where id=$1", [existente]);
    const antes = (await q("select count(*)::int n from catalog_service_details where organization_id=$1", [a.org]))[0].n;
    await expect(
      salvar(a.org, null, { ...novoItem(1_000), codigo }, { tipo: "projeto", unidade: "hora" }),
    ).rejects.toMatchObject({ code: "23505" });
    expect((await q("select count(*)::int n from catalog_service_details where organization_id=$1", [a.org]))[0].n).toBe(antes);
  });

  it("a organização de quem chama manda: editar o item de outra organização é 'não encontrado'", async () => {
    const deB = await salvar(b.org, null, novoItem(1_000), { tipo: "projeto", unidade: "hora" });
    await expect(salvar(a.org, deB.product_id, { preco_cents: 1 }, {}, deB.revision)).rejects.toThrow("servico_nao_encontrado");
  });
});

describe("a família travada em concorrência", () => {
  it("o preço de uma variação e o sinal do principal passam em fila, e o segundo vê o primeiro", async () => {
    const p = await salvar(a.org, null, novoItem(100_000), { tipo: "projeto", unidade: "valor_fechado" });
    const v = await salvar(a.org, null, novoItem(80_000), { pai_product_id: p.product_id });

    const t1 = await pool.connect();
    try {
      await t1.query("begin");
      // T1 baixa a variação para R$ 500 e segura a família sem confirmar.
      await salvar(a.org, v.product_id, { preco_cents: 50_000 }, {}, v.revision, t1);
      // T2 pede sinal fixo de R$ 600 — que cabia no preço que T2 leria sem a trava.
      const t2 = salvar(a.org, p.product_id, {}, { sinal_tipo: "fixo", sinal_cents: 60_000 }, p.revision);
      const espera = await Promise.race([t2.then(() => "terminou", () => "terminou"), new Promise((r) => setTimeout(() => r("esperando"), 500))]);
      expect(espera).toBe("esperando");
      await t1.query("commit");
      await expect(t2).rejects.toThrow("servico_sinal_acima_do_preco");
    } finally {
      t1.release();
    }
  });
});

describe("apagar o principal", () => {
  it("leva o detalhe das variações, e os itens delas ficam no catálogo com o preço", async () => {
    const p = await salvar(a.org, null, novoItem(100_000), { tipo: "projeto", unidade: "valor_fechado" });
    const v = await salvar(a.org, null, novoItem(80_000), { pai_product_id: p.product_id });
    await q("delete from catalog_products where id=$1", [p.product_id]);
    expect(await q("select 1 from catalog_service_details where product_id=$1", [v.product_id])).toHaveLength(0);
    expect(await q("select preco_cents from catalog_products where id=$1", [v.product_id])).toEqual([{ preco_cents: "80000" }]);
  });
});
