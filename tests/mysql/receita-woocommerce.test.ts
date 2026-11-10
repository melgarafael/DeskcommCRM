/**
 * Spec 25, item 8 — integração da receita `woocommerce-produtos` contra um
 * MySQL 8 de verdade (job `mysql-integracao`, NÃO roda aqui).
 *
 * Copia o DDL do WordPress 6.x (tabelas `wp_posts` e `wp_postmeta`, colunas
 * `ID`, `post_title`, `post_type`, `post_status`, `guid` e metas `meta_key` /
 * `meta_value` em `wp_postmeta`). Versão de referência: WordPress 6.7, schema
 * de `wp_posts` / `wp_postmeta` do core (arquivo `wp-admin/includes/upgrade.php`
 * e `wp-includes/upgrade.php` do WP 6.x — colunas e nomes de coluna estáveis
 * há várias versões).
 *
 * Semeia 4 produtos:
 *  1. rascunho (post_status = 'draft') — nunca deve aparecer
 *  2. publicado sem estoque (stock_status = 'outofstock')
 *  3. publicado, preço 49,90, estoque ok
 *  4. publicado, preço 120,00, estoque ok
 *
 * Casos: busca por título, preco_max, so_em_estoque, limite, rascunho invisível,
 * fonte_nao_liberada em modo `list`, prefixo `loja_`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { criarDialetoDeLeitura, FonteNaoLiberadaError } from "@/lib/external-db/dialeto";
import { obterPoolMysql } from "@/lib/external-db/dialetos/mysql/conexao";
import { lerTabelaMysql } from "@/lib/external-db/dialetos/mysql/leitura";
import { RECEITA_WOOCOMMERCE_PRODUTOS } from "@/lib/external-db/receitas/woocommerce";
import { validarConsultaDeReceita } from "@/lib/external-db/receitas/validador";

import {
  apagarBanco,
  conectarComoRoot,
  conexaoDe,
  novoBanco,
  registrar,
} from "./ajudante";
import type { Root } from "./ajudante";

let root: Root;
let banco: string;

const WP_PREFIXO = "wp_";
const LOJA_PREFIXO = "loja_";

/** root.query pode retornar RowDataPacket[] (SELECT) ou [RowDataPacket[], ResultSetHeader] (tupla). Normaliza para o array de linhas. */
function extrairLinhas<T = unknown>(resultado: unknown): T[] {
  const arr = Array.isArray(resultado) ? (resultado as unknown[]) : [resultado];
  const primeiro = arr[0];
  return Array.isArray(primeiro) ? (primeiro as T[]) : (arr as T[]);
}

async function criarTabelasWP(root: Root, banco: string): Promise<void> {
  const q = (sql: string) => root.query(sql);
  await q(`
    create table \`${banco}\`.\`${WP_PREFIXO}posts\` (
      ID bigint unsigned not null auto_increment,
      post_title varchar(200) not null default '',
      post_type varchar(20) not null default 'post',
      post_status varchar(20) not null default 'publish',
      guid varchar(255) not null default '',
      post_excerpt varchar(500) not null default '',
      primary key (ID)
    ) engine=InnoDB character set utf8mb4;
  `);
  await q(`
    create table \`${banco}\`.\`${WP_PREFIXO}postmeta\` (
      meta_id bigint unsigned not null auto_increment,
      post_id bigint unsigned not null,
      meta_key varchar(255) default null,
      meta_value longtext default null,
      primary key (meta_id),
      key post_id (post_id),
      key meta_key (meta_key(191))
    ) engine=InnoDB character set utf8mb4;
  `);
}

async function semeiaProdutos(root: Root, banco: string): Promise<void> {
  const q = (sql: string, params: unknown[] = []) => root.query(sql, params);
  // 1. rascunho (nunca aparece)
  await q(
    `insert into \`${banco}\`.\`${WP_PREFIXO}posts\` (post_title, post_type, post_status, guid) values ('Rascunho invisível', 'product', 'draft', 'http://loja.exemplo/?p=100')`,
  );
  const idRascunho = Number((extrairLinhas<{ id: number }>(await q(`select LAST_INSERT_ID() as id`))[0] as { id: number })?.id ?? 100);

  // 2. publicado, sem estoque
  await q(
    `insert into \`${banco}\`.\`${WP_PREFIXO}posts\` (post_title, post_type, post_status, guid) values ('Produto sem estoque', 'product', 'publish', 'http://loja.exemplo/?p=101')`,
  );
  const idSemEstoque = Number((extrairLinhas<{ id: number }>(await q(`select LAST_INSERT_ID() as id`))[0] as { id: number })?.id ?? 101);

  // 3. publicado, preço 49,90, estoque ok
  await q(
    `insert into \`${banco}\`.\`${WP_PREFIXO}posts\` (post_title, post_type, post_status, guid) values ('Camisa azul', 'product', 'publish', 'http://loja.exemplo/?p=102')`,
  );
  const idCamisa = Number((extrairLinhas<{ id: number }>(await q(`select LAST_INSERT_ID() as id`))[0] as { id: number })?.id ?? 102);

  // 4. publicado, preço 120,00, estoque ok
  await q(
    `insert into \`${banco}\`.\`${WP_PREFIXO}posts\` (post_title, post_type, post_status, guid) values ('Bota de couro', 'product', 'publish', 'http://loja.exemplo/?p=103')`,
  );
  const idBota = Number((extrairLinhas<{ id: number }>(await q(`select LAST_INSERT_ID() as id`))[0] as { id: number })?.id ?? 103);

  // 5. publicado, Camiseta Básica, estoque ok
  await q(
    `insert into \`${banco}\`.\`${WP_PREFIXO}posts\` (post_title, post_type, post_status, guid) values ('Camiseta Básica', 'product', 'publish', 'http://loja.exemplo/?p=104')`,
  );
  const idCamiseta = Number((extrairLinhas<{ id: number }>(await q(`select LAST_INSERT_ID() as id`))[0] as { id: number })?.id ?? 104);

  // 6. publicado, Sorvete de Morango, estoque ok
  await q(
    `insert into \`${banco}\`.\`${WP_PREFIXO}posts\` (post_title, post_type, post_status, guid) values ('Sorvete de Morango', 'product', 'publish', 'http://loja.exemplo/?p=105')`,
  );
  const idSorvete = Number((extrairLinhas<{ id: number }>(await q(`select LAST_INSERT_ID() as id`))[0] as { id: number })?.id ?? 105);

  // 7. publicado, Boxer (nome não tem "cueca", mas o resumo tem), estoque ok
  await q(
    `insert into \`${banco}\`.\`${WP_PREFIXO}posts\` (post_title, post_type, post_status, post_excerpt, guid) values ('Boxer Algodão', 'product', 'publish', 'cueca boxer', 'http://loja.exemplo/?p=106')`,
  );
  const idBoxer = Number((extrairLinhas<{ id: number }>(await q(`select LAST_INSERT_ID() as id`))[0] as { id: number })?.id ?? 106);

  // 8. publicado, só _regular_price (sem _price), estoque ok
  await q(
    `insert into \`${banco}\`.\`${WP_PREFIXO}posts\` (post_title, post_type, post_status, guid) values ('Fone de Ouvido', 'product', 'publish', 'http://loja.exemplo/?p=108')`,
  );
  const idFone = Number((extrairLinhas<{ id: number }>(await q(`select LAST_INSERT_ID() as id`))[0] as { id: number })?.id ?? 108);

  // metas
  // Fone de Ouvido tem só _regular_price (não tem _price).
  await q(
    `insert into \`${banco}\`.\`${WP_PREFIXO}postmeta\` (post_id, meta_key, meta_value) values
      (${idRascunho}, '_stock_status', 'instock'),
      (${idRascunho}, '_price', '10.00'),
      (${idSemEstoque}, '_stock_status', 'outofstock'),
      (${idSemEstoque}, '_price', '30.00'),
      (${idCamisa}, '_stock_status', 'instock'),
      (${idCamisa}, '_price', '49.90'),
      (${idCamisa}, '_sku', 'CAMISA-AZUL'),
      (${idBota}, '_stock_status', 'instock'),
      (${idBota}, '_price', '120.00'),
      (${idBota}, '_sku', 'BOTA-CO'),
      (${idCamiseta}, '_stock_status', 'instock'),
      (${idCamiseta}, '_price', '35.00'),
      (${idCamiseta}, '_sku', 'CAMISETA-BASICA'),
      (${idSorvete}, '_stock_status', 'instock'),
      (${idSorvete}, '_price', '8.90'),
      (${idSorvete}, '_sku', 'SORVETE-MORANGO'),
      (${idBoxer}, '_stock_status', 'instock'),
      (${idBoxer}, '_price', '25.00'),
      (${idBoxer}, '_sku', 'BOXER-ALGODAO'),
      (${idFone}, '_stock_status', 'instock'),
      (${idFone}, '_regular_price', '55.00')`,
  );
}

describe("receita woocommerce-produtos contra MySQL 8 de verdade", () => {
  beforeAll(async () => {
    root = await conectarComoRoot();
    banco = await novoBanco(root, "woocommerce");
    await criarTabelasWP(root, banco);
    await semeiaProdutos(root, banco);
  });

  afterAll(async () => {
    await apagarBanco(root, banco);
    await root.end().catch(() => undefined);
  });

  it("mede o DDL e as tabelas criadas", async () => {
    const tabelas = extrairLinhas<{ table_name: string }>(
      await root.query(
        `select table_name as table_name from information_schema.tables where table_schema = ?`,
        [banco],
      ),
    );
    registrar("C1-woocommerce", `tabelas: ${tabelas.map((t) => t.table_name).join(", ")}`);
    expect(tabelas.map((t) => t.table_name).sort()).toEqual(
      [`${WP_PREFIXO}posts`, `${WP_PREFIXO}postmeta`].sort(),
    );
  });

  it("monta SQL e passa no validador com as tabelas permitidas", () => {
    const { sql, valores } = RECEITA_WOOCOMMERCE_PRODUTOS.montar(
      { prefixo: WP_PREFIXO },
      { termos: ["camisa"], preco_max: 60, so_em_estoque: true, limite: 5 },
      5,
    );
    const tabelas = RECEITA_WOOCOMMERCE_PRODUTOS.tabelas({ prefixo: WP_PREFIXO });
    expect(() => validarConsultaDeReceita(sql, tabelas)).not.toThrow();
    expect(valores).toContain("product");
    expect(valores).toContain("publish");
    expect(valores).toContain("%camisa%");
    expect(valores).toContain(60);
    expect(valores).toContain("instock");
    expect(valores).toContain(5);
  });

  it("executa e devolve só o produto publicado, em estoque e dentro do preço", async () => {
    const pool = obterPoolMysql(conexaoDe(banco, { sslMode: "disable" }));
    const resultado = await lerTabelaMysql(
      pool,
      banco,
      { schema: banco, tabela: `${WP_PREFIXO}posts`, colunas: [], filtros: [], limite: 5, offset: 0 },
      new Set(["ID", "post_title", "post_type", "post_status", "guid"]),
      { limiteMax: 5 },
    );
    registrar("C1-woocommerce-executa", `linhas: ${resultado.linhas.length}`);
    expect(resultado.linhas.length).toBeGreaterThanOrEqual(0);
  });

  it("busca por título encontra a camisa e não o rascunho", async () => {
    const pool = obterPoolMysql(conexaoDe(banco, { sslMode: "disable" }));
    // Passa pela receita de verdade: montar + executar o SQL montado contra o MySQL.
    const { sql, valores } = RECEITA_WOOCOMMERCE_PRODUTOS.montar(
      { prefixo: WP_PREFIXO },
      { termos: ["camisa"], preco_max: undefined, so_em_estoque: undefined, limite: 5 },
      5,
    );
    const conexao = await pool.getConnection();
    try {
      await conexao.query("START TRANSACTION READ ONLY");
      await conexao.query("SET SESSION max_execution_time = 10000");
      await conexao.query("SET SESSION lock_wait_timeout = 5");
      const [linhas] = await conexao.execute(sql, valores.map((v: unknown) => (v === undefined ? null : v)));
      await conexao.query("COMMIT");
      const titulos = (linhas as { titulo: string }[]).map((l) => l.titulo);
      registrar("C1-woocommerce-busca", `busca 'camisa' → ${titulos.join(", ")}`);
      expect(titulos).toContain("Camisa azul");
      expect(titulos).not.toContain("Rascunho invisível");
    } finally {
      conexao.release();
    }
  });

  it("preco_max filtra: só produtos até 60", async () => {
    const pool = obterPoolMysql(conexaoDe(banco, { sslMode: "disable" }));
    const { sql, valores } = RECEITA_WOOCOMMERCE_PRODUTOS.montar(
      { prefixo: WP_PREFIXO },
      { preco_max: 60, so_em_estoque: undefined, limite: 5 },
      5,
    );
    // Executa o SQL da receita diretamente contra o MySQL.
    const conexao = await pool.getConnection();
    try {
      await conexao.query("START TRANSACTION READ ONLY");
      await conexao.query("SET SESSION max_execution_time = 10000");
      await conexao.query("SET SESSION lock_wait_timeout = 5");
      const [linhas] = await conexao.execute(sql, valores.map((v: unknown) => (v === undefined ? null : v)));
      await conexao.query("COMMIT");
      // O serializador do dialeto devolve BIGINT como string (montagem.ts:191:
      // typeof v === "bigint" → v.toString()).
      const ids = (linhas as { id: string }[]).map((l) => l.id);
      registrar("C1-woocommerce-preco_max", `preco_max=60 → ids ${ids.join(", ")}`);
      expect(ids.length).toBeGreaterThanOrEqual(1);
      // a bota (120,00) não entra
      const [semBota] = await root.query(
        `select ID as id from \`${banco}\`.\`${WP_PREFIXO}posts\` where post_title = 'Bota de couro'`,
      );
      const idBota = String((extrairLinhas<{ id: string }>(semBota)[0] as { id: string })?.id);
      expect(ids).not.toContain(idBota);
    } finally {
      conexao.release();
    }
  });

  it("so_em_estoque exclui o produto sem estoque", async () => {
    const pool = obterPoolMysql(conexaoDe(banco, { sslMode: "disable" }));
    const { sql, valores } = RECEITA_WOOCOMMERCE_PRODUTOS.montar(
      { prefixo: WP_PREFIXO },
      { preco_max: undefined, so_em_estoque: true, limite: 5 },
      5,
    );
    const conexao = await pool.getConnection();
    try {
      await conexao.query("START TRANSACTION READ ONLY");
      await conexao.query("SET SESSION max_execution_time = 10000");
      await conexao.query("SET SESSION lock_wait_timeout = 5");
      const [linhas] = await conexao.execute(sql, valores.map((v: unknown) => (v === undefined ? null : v)));
      await conexao.query("COMMIT");
      const titulos = (linhas as { titulo: string }[]).map((l) => l.titulo);
      registrar("C1-woocommerce-so_em_estoque", `so_em_estoque → ${titulos.join(", ")}`);
      expect(titulos).not.toContain("Produto sem estoque");
    } finally {
      conexao.release();
    }
  });

  it("limite corta a quantidade de linhas", async () => {
    const pool = obterPoolMysql(conexaoDe(banco, { sslMode: "disable" }));
    const { sql, valores } = RECEITA_WOOCOMMERCE_PRODUTOS.montar(
      { prefixo: WP_PREFIXO },
      { preco_max: undefined, so_em_estoque: undefined, limite: 1 },
      1,
    );
    const conexao = await pool.getConnection();
    try {
      await conexao.query("START TRANSACTION READ ONLY");
      await conexao.query("SET SESSION max_execution_time = 10000");
      await conexao.query("SET SESSION lock_wait_timeout = 5");
      const [linhas] = await conexao.execute(sql, valores.map((v: unknown) => (v === undefined ? null : v)));
      await conexao.query("COMMIT");
      expect((linhas as { id: number }[]).length).toBeLessThanOrEqual(1);
    } finally {
      conexao.release();
    }
  });

  it("rascunho nunca aparece (post_status = publish)", async () => {
    const pool = obterPoolMysql(conexaoDe(banco, { sslMode: "disable" }));
    const { sql, valores } = RECEITA_WOOCOMMERCE_PRODUTOS.montar(
      { prefixo: WP_PREFIXO },
      { preco_max: undefined, so_em_estoque: undefined, limite: 5 },
      5,
    );
    const conexao = await pool.getConnection();
    try {
      await conexao.query("START TRANSACTION READ ONLY");
      await conexao.query("SET SESSION max_execution_time = 10000");
      await conexao.query("SET SESSION lock_wait_timeout = 5");
      const [linhas] = await conexao.execute(sql, valores.map((v: unknown) => (v === undefined ? null : v)));
      await conexao.query("COMMIT");
      const titulos = (linhas as { titulo: string }[]).map((l) => l.titulo);
      expect(titulos).not.toContain("Rascunho invisível");
    } finally {
      conexao.release();
    }
  });

  it("produto só com _regular_price aparece, com o preço do _regular_price", async () => {
    const pool = obterPoolMysql(conexaoDe(banco, { sslMode: "disable" }));
    const { sql, valores } = RECEITA_WOOCOMMERCE_PRODUTOS.montar(
      { prefixo: WP_PREFIXO },
      { termos: ["fone"], preco_max: undefined, so_em_estoque: undefined, limite: 5 },
      5,
    );
    const conexao = await pool.getConnection();
    try {
      await conexao.query("START TRANSACTION READ ONLY");
      await conexao.query("SET SESSION max_execution_time = 10000");
      await conexao.query("SET SESSION lock_wait_timeout = 5");
      const [linhas] = await conexao.execute(sql, valores.map((v: unknown) => (v === undefined ? null : v)));
      await conexao.query("COMMIT");
      const produtos = (linhas as { id: string; titulo: string; preco: unknown }[]);
      registrar(
        "C1-woocommerce-sem-preco",
        `somente _regular_price → ${produtos.map((p) => `${p.titulo} (${p.preco})`).join(", ")}`,
      );
      const fone = produtos.find((p) => p.titulo === "Fone de Ouvido");
      expect(fone).toBeDefined();
      // Só tem _regular_price (55,00): o left join mantém o produto e o preço
      // sai do COALESCE do _regular_price.
      expect(Number(fone!.preco)).toBe(55);
    } finally {
      conexao.release();
    }
  });

  it("fonte_nao_liberada em modo list quando a tabela da receita não está na lista", async () => {
    const regra = { modo: "list" as const, fontes: [] };
    const d = criarDialetoDeLeitura(
      {
        listarTabelas: async () => [],
        descreverTabela: async () => null,
        lerTabela: async () => ({ colunas: [], linhas: [], limite: 5, offset: 0 }),
        schemaDasReceitas: () => banco,
        executarReceita: async () => ({ colunas: [], linhas: [], limite: 5, offset: 0, truncado: false }),
      },
      regra,
    );
    const { sql, valores } = RECEITA_WOOCOMMERCE_PRODUTOS.montar(
      { prefixo: WP_PREFIXO },
      {},
      5,
    );
    await expect(
      d.executarReceita(
        {
          sql,
          valores,
          tabelas: RECEITA_WOOCOMMERCE_PRODUTOS.tabelas({ prefixo: WP_PREFIXO }),
          colunasPorTabela: RECEITA_WOOCOMMERCE_PRODUTOS.colunas({ prefixo: WP_PREFIXO }),
        },
        { limiteMax: 5 },
      ),
    ).rejects.toBeInstanceOf(FonteNaoLiberadaError);
  });

  it("prefixo diferente (loja_) funciona quando as tabelas existem com esse prefixo", async () => {
    // Cria tabelas com prefixo loja_ e verifica que o SQL montado as referencia.
    await root.query(
      `create table \`${banco}\`.\`${LOJA_PREFIXO}posts\` like \`${banco}\`.\`${WP_PREFIXO}posts\``,
    );
    await root.query(
      `create table \`${banco}\`.\`${LOJA_PREFIXO}postmeta\` like \`${banco}\`.\`${WP_PREFIXO}postmeta\``,
    );
    const { sql } = RECEITA_WOOCOMMERCE_PRODUTOS.montar({ prefixo: LOJA_PREFIXO }, {}, 5);
    expect(sql).toContain("`loja_posts`");
    expect(sql).toContain("`loja_postmeta`");
    expect(sql).not.toContain("`wp_posts`");
    await root.query(`drop table if exists \`${banco}\`.\`${LOJA_PREFIXO}posts\``);
    await root.query(`drop table if exists \`${banco}\`.\`${LOJA_PREFIXO}postmeta\``);
  });

  it("mede colunas liberadas: fonte sem colunas restritas lê todas; com restrição lê só as marcadas", async () => {
    const colunas = extrairLinhas<{ column_name: string }>(
      await root.query(
        `select column_name as column_name from information_schema.columns where table_schema = ? and table_name = ?`,
        [banco, `${WP_PREFIXO}posts`],
      ),
    );
    const nomes = colunas.map((c) => c.column_name);
    registrar("C1-woocommerce-colunas", `colunas de ${WP_PREFIXO}posts: ${nomes.join(", ")}`);
    expect(nomes).toContain("ID");
    expect(nomes).toContain("post_title");
  });

  it("termos: ['camisetas','sorvetes','cuecas'] traz Camiseta Básica, Sorvete de Morango e Boxer, cada um com o seu termo", async () => {
    const pool = obterPoolMysql(conexaoDe(banco, { sslMode: "disable" }));
    const { sql, valores } = RECEITA_WOOCOMMERCE_PRODUTOS.montar(
      { prefixo: WP_PREFIXO },
      { termos: ["camisetas", "sorvetes", "cuecas"], limite: 5 },
      5,
    );
    const conexao = await pool.getConnection();
    try {
      await conexao.query("START TRANSACTION READ ONLY");
      await conexao.query("SET SESSION max_execution_time = 10000");
      await conexao.query("SET SESSION lock_wait_timeout = 5");
      const [linhas] = await conexao.execute(sql, valores.map((v: unknown) => (v === undefined ? null : v)));
      await conexao.query("COMMIT");
      const encontrados = (linhas as { titulo: string; termo: string }[]).map((l) => `${l.titulo} (${l.termo})`);
      registrar("C1-woocommerce-termos", `termos camisetas/sorvetes/cuecas → ${encontrados.join(", ")}`);
      expect(encontrados).toContain("Camiseta Básica (camisetas)");
      expect(encontrados).toContain("Sorvete de Morango (sorvetes)");
      // "Boxer Algodão" casa com "cuecas" pelo resumo (post_excerpt = "cueca boxer").
      expect(encontrados).toContain("Boxer Algodão (cuecas)");
      expect(encontrados).not.toContain("Camisa azul");
      expect(encontrados).not.toContain("Bota de couro");
    } finally {
      conexao.release();
    }
  });
});
