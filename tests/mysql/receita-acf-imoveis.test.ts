/**
 * Spec 25, item 8 — integração da receita `acf-imoveis` contra um
 * MySQL 8 de verdade (job `mysql-integracao`, NÃO roda aqui).
 *
 * Copia o DDL do WordPress 6.x (tabelas `wp_posts` e `wp_postmeta`).
 * Versão de referência: WordPress 6.7.
 *
 * Semeia 5 imóveis do tipo `imovel` com pares ACF (`preco`/`_preco`…):
 *  1. rascunho (post_status = 'draft') — nunca deve aparecer
 *  2. publicado, preço "650.000,00" (formato com ponto e vírgula)
 *  3. publicado, preço "480000" (formato puro)
 *  4. bairro "Asa Norte", quartos 2
 *  5. bairro "Centro", quartos 3
 *  Mais 1 post de outro tipo (`post`) com os mesmos campos — NUNCA aparece.
 *
 * Casos: bairro (case-insensitive), quartos_min, preco_max (os dois formatos),
 * limite, rascunho invisível, outro post_type invisível, mapeamento com nomes
 * diferentes (valor/dormitorios), fonte_nao_liberada em modo `list`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { criarDialetoDeLeitura, FonteNaoLiberadaError } from "@/lib/external-db/dialeto";
import { obterPoolMysql } from "@/lib/external-db/dialetos/mysql/conexao";
import { RECEITA_ACF_IMOVEIS } from "@/lib/external-db/receitas/acf-imoveis";
import { validarConsultaDeReceita } from "@/lib/external-db/receitas/validador";

import { apagarBanco, conectarComoRoot, conexaoDe, novoBanco, registrar } from "./ajudante";
import type { Root } from "./ajudante";

let root: Root;
let banco: string;

const WP_PREFIXO = "wp_";

/** root.query pode retornar RowDataPacket[] (SELECT) ou [RowDataPacket[], ResultSetHeader] (tupla). Normaliza. */
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

async function semeiaImoveis(root: Root, banco: string): Promise<void> {
  const q = (sql: string, params: unknown[] = []) => root.query(sql, params);

  // 1. rascunho (nunca aparece)
  await q(
    `insert into \`${banco}\`.\`${WP_PREFIXO}posts\` (post_title, post_type, post_status, guid) values ('Rascunho invisível', 'imovel', 'draft', 'http://imoveis.exemplo/?p=1')`,
  );
  const idRascunho = Number(
    (extrairLinhas<{ id: number }>(await q(`select LAST_INSERT_ID() as id`))[0] as { id: number })
      ?.id ?? 1,
  );

  // 2. publicado, preço "650.000,00" (formato brasileiro)
  await q(
    `insert into \`${banco}\`.\`${WP_PREFIXO}posts\` (post_title, post_type, post_status, guid) values ('Apartamento Asa Norte', 'imovel', 'publish', 'http://imoveis.exemplo/?p=2')`,
  );
  const idAsaNorte = Number(
    (extrairLinhas<{ id: number }>(await q(`select LAST_INSERT_ID() as id`))[0] as { id: number })
      ?.id ?? 2,
  );

  // 3. publicado, preço "480000" (formato puro)
  await q(
    `insert into \`${banco}\`.\`${WP_PREFIXO}posts\` (post_title, post_type, post_status, guid) values ('Casa Centro', 'imovel', 'publish', 'http://imoveis.exemplo/?p=3')`,
  );
  const idCentro = Number(
    (extrairLinhas<{ id: number }>(await q(`select LAST_INSERT_ID() as id`))[0] as { id: number })
      ?.id ?? 3,
  );

  // 4. publicado, bairro "Asa Norte", quartos 2
  await q(
    `insert into \`${banco}\`.\`${WP_PREFIXO}posts\` (post_title, post_type, post_status, guid) values ('Apartamento 2 quartos', 'imovel', 'publish', 'http://imoveis.exemplo/?p=4')`,
  );
  const idDoisQuartos = Number(
    (extrairLinhas<{ id: number }>(await q(`select LAST_INSERT_ID() as id`))[0] as { id: number })
      ?.id ?? 4,
  );

  // 5. publicado, bairro "Centro", quartos 3
  await q(
    `insert into \`${banco}\`.\`${WP_PREFIXO}posts\` (post_title, post_type, post_status, guid) values ('Casa 3 quartos', 'imovel', 'publish', 'http://imoveis.exemplo/?p=5')`,
  );
  const idTresQuartos = Number(
    (extrairLinhas<{ id: number }>(await q(`select LAST_INSERT_ID() as id`))[0] as { id: number })
      ?.id ?? 5,
  );

  // 6. outro post_type (post) com mesmos campos — NUNCA deve aparecer
  await q(
    `insert into \`${banco}\`.\`${WP_PREFIXO}posts\` (post_title, post_type, post_status, guid) values ('Artigo do blog', 'post', 'publish', 'http://blog.exemplo/?p=1')`,
  );
  const idBlog = Number(
    (extrairLinhas<{ id: number }>(await q(`select LAST_INSERT_ID() as id`))[0] as { id: number })
      ?.id ?? 6,
  );

  // 7. publicado, preço "650000.50" (ponto decimal, 2 dígitos no fim)
  await q(
    `insert into \`${banco}\`.\`${WP_PREFIXO}posts\` (post_title, post_type, post_status, guid) values ('Cobertura com ponto decimal', 'imovel', 'publish', 'http://imoveis.exemplo/?p=7')`,
  );
  const idPontoDecimal = Number(
    (extrairLinhas<{ id: number }>(await q(`select LAST_INSERT_ID() as id`))[0] as { id: number })
      ?.id ?? 7,
  );

  // 8. publicado, preço "1.200.000" (pontos = milhar, sem vírgula) → deve virar 1200000
  await q(
    `insert into \`${banco}\`.\`${WP_PREFIXO}posts\` (post_title, post_type, post_status, guid) values ('Casa com pontos milhar', 'imovel', 'publish', 'http://imoveis.exemplo/?p=8')`,
  );
  const idMilhar = Number(
    (extrairLinhas<{ id: number }>(await q(`select LAST_INSERT_ID() as id`))[0] as { id: number })
      ?.id ?? 8,
  );

  // metas ACF (pares meta_key / _meta_key)
  await q(
    `insert into \`${banco}\`.\`${WP_PREFIXO}postmeta\` (post_id, meta_key, meta_value) values
      (${idRascunho}, '_preco', 'preco_50'),
      (${idRascunho}, 'preco', '50.000,00'),
      (${idRascunho}, '_quartos', 'quartos_2'),
      (${idRascunho}, 'quartos', '2'),
      (${idRascunho}, '_bairro', 'bairro_rascunho'),
      (${idRascunho}, 'bairro', 'Bairro Rascunho'),
      (${idAsaNorte}, '_preco', 'preco_650'),
      (${idAsaNorte}, 'preco', '650.000,00'),
      (${idAsaNorte}, '_quartos', 'quartos_3'),
      (${idAsaNorte}, 'quartos', '3'),
      (${idAsaNorte}, '_bairro', 'bairro_asa_norte'),
      (${idAsaNorte}, 'bairro', 'Asa Norte'),
      (${idCentro}, '_preco', 'preco_480'),
      (${idCentro}, 'preco', '480000'),
      (${idCentro}, '_quartos', 'quartos_2'),
      (${idCentro}, 'quartos', '2'),
      (${idCentro}, '_bairro', 'bairro_centro'),
      (${idCentro}, 'bairro', 'Centro'),
      (${idDoisQuartos}, '_preco', 'preco_300'),
      (${idDoisQuartos}, 'preco', '300000'),
      (${idDoisQuartos}, '_quartos', 'quartos_2'),
      (${idDoisQuartos}, 'quartos', '2'),
      (${idDoisQuartos}, '_bairro', 'bairro_asul'),
      (${idDoisQuartos}, 'bairro', 'Asa Sul'),
      (${idTresQuartos}, '_preco', 'preco_700'),
      (${idTresQuartos}, 'preco', '700000'),
      (${idTresQuartos}, '_quartos', 'quartos_3'),
      (${idTresQuartos}, 'quartos', '3'),
      (${idTresQuartos}, '_bairro', 'bairro_lago'),
      (${idTresQuartos}, 'bairro', 'Lago Sul'),
      (${idBlog}, '_preco', 'preco_blog'),
      (${idBlog}, 'preco', '1000'),
      (${idBlog}, '_quartos', 'quartos_blog'),
      (${idBlog}, 'quartos', '1'),
      (${idBlog}, '_bairro', 'bairro_blog'),
      (${idBlog}, 'bairro', 'Blog Bairro'),
      (${idPontoDecimal}, '_preco', 'preco_decimal'),
      (${idPontoDecimal}, 'preco', '650000.50'),
      (${idPontoDecimal}, '_quartos', 'quartos_decimal'),
      (${idPontoDecimal}, 'quartos', '4'),
      (${idPontoDecimal}, '_bairro', 'bairro_decimal'),
      (${idPontoDecimal}, 'bairro', 'Bairro Decimal'),
      (${idMilhar}, '_preco', 'preco_milhar'),
      (${idMilhar}, 'preco', '1.200.000'),
      (${idMilhar}, '_quartos', 'quartos_milhar'),
      (${idMilhar}, 'quartos', '3'),
      (${idMilhar}, '_bairro', 'bairro_milhar'),
      (${idMilhar}, 'bairro', 'Bairro Milhar')`,
  );
}

describe("receita acf-imoveis contra MySQL 8 de verdade", () => {
  beforeAll(async () => {
    root = await conectarComoRoot();
    banco = await novoBanco(root, "acf-imoveis");
    await criarTabelasWP(root, banco);
    await semeiaImoveis(root, banco);
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
    registrar("C1-acf-imoveis", `tabelas: ${tabelas.map((t) => t.table_name).join(", ")}`);
    expect(tabelas.map((t) => t.table_name).sort()).toEqual(
      [`${WP_PREFIXO}posts`, `${WP_PREFIXO}postmeta`].sort(),
    );
  });

  it("monta SQL e passa no validador com as tabelas permitidas", () => {
    const { sql, valores } = RECEITA_ACF_IMOVEIS.montar(
      {
        prefixo: WP_PREFIXO,
        post_type: "imovel",
        campos: { preco: "preco", quartos: "quartos", bairro: "bairro" },
      },
      {},
      5,
    );
    const tabelas = RECEITA_ACF_IMOVEIS.tabelas(WP_PREFIXO);
    expect(() => validarConsultaDeReceita(sql, tabelas)).not.toThrow();
    expect(valores).toContain("imovel");
    expect(valores).toContain("publish");
    expect(valores).toContain("preco");
    expect(valores).toContain("quartos");
    expect(valores).toContain("bairro");
    expect(sql.split("?").length - 1).toBe(valores.length);
  });

  it("executa e devolve só imóveis publicados do tipo imovel", async () => {
    const pool = obterPoolMysql(conexaoDe(banco, { sslMode: "disable" }));
    const { sql, valores } = RECEITA_ACF_IMOVEIS.montar(
      {
        prefixo: WP_PREFIXO,
        post_type: "imovel",
        campos: { preco: "preco", quartos: "quartos", bairro: "bairro" },
      },
      {},
      5,
    );
    const conexao = await pool.getConnection();
    try {
      await conexao.query("START TRANSACTION READ ONLY");
      await conexao.query("SET SESSION max_execution_time = 10000");
      await conexao.query("SET SESSION lock_wait_timeout = 5");
      const [linhas] = await conexao.execute(
        sql,
        valores.map((v: unknown) => (v === undefined ? null : v)),
      );
      await conexao.query("COMMIT");
      const titulos = (linhas as { titulo: string }[]).map((l) => l.titulo);
      registrar("C1-acf-imoveis-executa", `títulos: ${titulos.join(", ")}`);
      expect(titulos).toContain("Apartamento Asa Norte");
      expect(titulos).toContain("Casa Centro");
      expect(titulos).toContain("Apartamento 2 quartos");
      expect(titulos).toContain("Casa 3 quartos");
      expect(titulos).not.toContain("Rascunho invisível");
      expect(titulos).not.toContain("Artigo do blog");
    } finally {
      conexao.release();
    }
  });

  it("bairro filtra sem diferenciar maiúsculas e minúsculas", async () => {
    const pool = obterPoolMysql(conexaoDe(banco, { sslMode: "disable" }));
    const { sql, valores } = RECEITA_ACF_IMOVEIS.montar(
      {
        prefixo: WP_PREFIXO,
        post_type: "imovel",
        campos: { preco: "preco", quartos: "quartos", bairro: "bairro" },
      },
      { bairro: "ASA NORTE" },
      5,
    );
    const conexao = await pool.getConnection();
    try {
      await conexao.query("START TRANSACTION READ ONLY");
      await conexao.query("SET SESSION max_execution_time = 10000");
      await conexao.query("SET SESSION lock_wait_timeout = 5");
      const [linhas] = await conexao.execute(
        sql,
        valores.map((v: unknown) => (v === undefined ? null : v)),
      );
      await conexao.query("COMMIT");
      const titulos = (linhas as { titulo: string }[]).map((l) => l.titulo);
      registrar("C1-acf-imoveis-bairro", `bairro 'ASA NORTE' → ${titulos.join(", ")}`);
      expect(titulos).toContain("Apartamento Asa Norte");
      expect(titulos).not.toContain("Casa Centro");
    } finally {
      conexao.release();
    }
  });

  it("quartos_min filtra imóveis com pelo menos N quartos", async () => {
    const pool = obterPoolMysql(conexaoDe(banco, { sslMode: "disable" }));
    const { sql, valores } = RECEITA_ACF_IMOVEIS.montar(
      {
        prefixo: WP_PREFIXO,
        post_type: "imovel",
        campos: { preco: "preco", quartos: "quartos", bairro: "bairro" },
      },
      { quartos_min: 3 },
      5,
    );
    const conexao = await pool.getConnection();
    try {
      await conexao.query("START TRANSACTION READ ONLY");
      await conexao.query("SET SESSION max_execution_time = 10000");
      await conexao.query("SET SESSION lock_wait_timeout = 5");
      const [linhas] = await conexao.execute(
        sql,
        valores.map((v: unknown) => (v === undefined ? null : v)),
      );
      await conexao.query("COMMIT");
      const titulos = (linhas as { titulo: string }[]).map((l) => l.titulo);
      registrar("C1-acf-imoveis-quartos_min", `quartos_min=3 → ${titulos.join(", ")}`);
      expect(titulos).toContain("Casa 3 quartos");
      expect(titulos).toContain("Apartamento Asa Norte"); // 3 quartos
      expect(titulos).not.toContain("Apartamento 2 quartos");
      expect(titulos).not.toContain("Casa Centro"); // 2 quartos
    } finally {
      conexao.release();
    }
  });

  it("preco_max aceita '650.000,00' (formato brasileiro) e '480000' (puro)", async () => {
    const pool = obterPoolMysql(conexaoDe(banco, { sslMode: "disable" }));

    // preco_max = 600000: pega Casa Centro (480000), Casa 3 quartos (700000 não), Apartamento 2 quartos (300000)
    const { sql, valores } = RECEITA_ACF_IMOVEIS.montar(
      {
        prefixo: WP_PREFIXO,
        post_type: "imovel",
        campos: { preco: "preco", quartos: "quartos", bairro: "bairro" },
      },
      { preco_max: 600000 },
      5,
    );
    const conexao = await pool.getConnection();
    try {
      await conexao.query("START TRANSACTION READ ONLY");
      await conexao.query("SET SESSION max_execution_time = 10000");
      await conexao.query("SET SESSION lock_wait_timeout = 5");
      const [linhas] = await conexao.execute(
        sql,
        valores.map((v: unknown) => (v === undefined ? null : v)),
      );
      await conexao.query("COMMIT");
      const titulos = (linhas as { titulo: string }[]).map((l) => l.titulo);
      registrar("C1-acf-imoveis-preco_max_600k", `preco_max=600000 → ${titulos.join(", ")}`);
      expect(titulos).toContain("Casa Centro"); // 480000
      expect(titulos).toContain("Apartamento 2 quartos"); // 300000
      expect(titulos).not.toContain("Apartamento Asa Norte"); // 650000 > 600000
      expect(titulos).not.toContain("Casa 3 quartos"); // 700000 > 600000
    } finally {
      conexao.release();
    }
  });

  it("preco_max trata ponto decimal: '650000.50' → 650000.5", async () => {
    const pool = obterPoolMysql(conexaoDe(banco, { sslMode: "disable" }));

    // preco_max = 650000: NÃO pega o imóvel com 650000.50 (é maior)
    const { sql: sql650k, valores: valores650k } = RECEITA_ACF_IMOVEIS.montar(
      {
        prefixo: WP_PREFIXO,
        post_type: "imovel",
        campos: { preco: "preco", quartos: "quartos", bairro: "bairro" },
      },
      { preco_max: 650000 },
      5,
    );
    const conexao = await pool.getConnection();
    try {
      await conexao.query("START TRANSACTION READ ONLY");
      await conexao.query("SET SESSION max_execution_time = 10000");
      await conexao.query("SET SESSION lock_wait_timeout = 5");
      const [linhas] = await conexao.execute(
        sql650k,
        valores650k.map((v: unknown) => (v === undefined ? null : v)),
      );
      await conexao.query("COMMIT");
      const titulos = (linhas as { titulo: string }[]).map((l) => l.titulo);
      registrar(
        "C1-acf-imoveis-preco_max_decimal_650k",
        `preco_max=650000 → ${titulos.join(", ")}`,
      );
      expect(titulos).not.toContain("Cobertura com ponto decimal"); // 650000.50 > 650000
    } finally {
      conexao.release();
    }

    // preco_max = 650001: pega o imóvel com 650000.50 (é menor)
    const { sql: sql650k1, valores: valores650k1 } = RECEITA_ACF_IMOVEIS.montar(
      {
        prefixo: WP_PREFIXO,
        post_type: "imovel",
        campos: { preco: "preco", quartos: "quartos", bairro: "bairro" },
      },
      { preco_max: 650001 },
      5,
    );
    const conexao2 = await pool.getConnection();
    try {
      await conexao2.query("START TRANSACTION READ ONLY");
      await conexao2.query("SET SESSION max_execution_time = 10000");
      await conexao2.query("SET SESSION lock_wait_timeout = 5");
      const [linhas] = await conexao2.execute(
        sql650k1,
        valores650k1.map((v: unknown) => (v === undefined ? null : v)),
      );
      await conexao2.query("COMMIT");
      const titulos = (linhas as { titulo: string }[]).map((l) => l.titulo);
      registrar(
        "C1-acf-imoveis-preco_max_decimal_650k1",
        `preco_max=650001 → ${titulos.join(", ")}`,
      );
      expect(titulos).toContain("Cobertura com ponto decimal"); // 650000.50 <= 650001
    } finally {
      conexao2.release();
    }
  });

  it("preco_max trata '1.200.000' como 1200000 (pontos milhar, sem vírgula)", async () => {
    const pool = obterPoolMysql(conexaoDe(banco, { sslMode: "disable" }));

    // preco_max = 1000000: NÃO pega o imóvel com 1.200.000 (1200000 > 1000000)
    const { sql: sql1m, valores: valores1m } = RECEITA_ACF_IMOVEIS.montar(
      {
        prefixo: WP_PREFIXO,
        post_type: "imovel",
        campos: { preco: "preco", quartos: "quartos", bairro: "bairro" },
      },
      { preco_max: 1000000, bairro: "milhar" }, // isola o imóvel: sem o bairro, o teto de 5 o esconderia de qualquer jeito
      5,
    );
    const conexao = await pool.getConnection();
    try {
      await conexao.query("START TRANSACTION READ ONLY");
      await conexao.query("SET SESSION max_execution_time = 10000");
      await conexao.query("SET SESSION lock_wait_timeout = 5");
      const [linhas] = await conexao.execute(
        sql1m,
        valores1m.map((v: unknown) => (v === undefined ? null : v)),
      );
      await conexao.query("COMMIT");
      const titulos = (linhas as { titulo: string }[]).map((l) => l.titulo);
      registrar("C1-acf-imoveis-preco_max_1m", `preco_max=1000000 → ${titulos.join(", ")}`);
      expect(titulos).not.toContain("Casa com pontos milhar"); // 1200000 > 1000000
    } finally {
      conexao.release();
    }

    // preco_max = 1300000: pega o imóvel com 1.200.000 (1200000 <= 1300000)
    const { sql: sql1m3, valores: valores1m3 } = RECEITA_ACF_IMOVEIS.montar(
      {
        prefixo: WP_PREFIXO,
        post_type: "imovel",
        campos: { preco: "preco", quartos: "quartos", bairro: "bairro" },
      },
      { preco_max: 1300000, bairro: "milhar" }, // 6 imóveis cabem no preço; sem o bairro, o teto de 5 corta o sexto
      5,
    );
    const conexao2 = await pool.getConnection();
    try {
      await conexao2.query("START TRANSACTION READ ONLY");
      await conexao2.query("SET SESSION max_execution_time = 10000");
      await conexao2.query("SET SESSION lock_wait_timeout = 5");
      const [linhas] = await conexao2.execute(
        sql1m3,
        valores1m3.map((v: unknown) => (v === undefined ? null : v)),
      );
      await conexao2.query("COMMIT");
      const titulos = (linhas as { titulo: string; preco: string }[]).map((l) => l);
      registrar(
        "C1-acf-imoveis-preco_max_1m3",
        `preco_max=1300000 → ${titulos.map((t) => t.titulo).join(", ")}`,
      );
      expect(titulos.map((t) => t.titulo)).toContain("Casa com pontos milhar"); // 1200000 <= 1300000
      // A coluna preco devolvida vale 1200000.
      const casaMilhar = titulos.find((t) => t.titulo === "Casa com pontos milhar");
      expect(casaMilhar).toBeDefined();
      expect(Number(casaMilhar!.preco)).toBe(1200000); // o MySQL devolve DECIMAL como texto ("1200000.00")
    } finally {
      conexao2.release();
    }

    // Confere que "480000" segue em 480000.
    const { sql: sql480, valores: valores480 } = RECEITA_ACF_IMOVEIS.montar(
      {
        prefixo: WP_PREFIXO,
        post_type: "imovel",
        campos: { preco: "preco", quartos: "quartos", bairro: "bairro" },
      },
      { preco_max: 480000 },
      5,
    );
    const conexao3 = await pool.getConnection();
    try {
      await conexao3.query("START TRANSACTION READ ONLY");
      await conexao3.query("SET SESSION max_execution_time = 10000");
      await conexao3.query("SET SESSION lock_wait_timeout = 5");
      const [linhas] = await conexao3.execute(
        sql480,
        valores480.map((v: unknown) => (v === undefined ? null : v)),
      );
      await conexao3.query("COMMIT");
      const titulos = (linhas as { titulo: string; preco: string }[]).map((l) => l);
      registrar(
        "C1-acf-imoveis-preco_max_480",
        `preco_max=480000 → ${titulos.map((t) => t.titulo).join(", ")}`,
      );
      const casaCentro = titulos.find((t) => t.titulo === "Casa Centro");
      expect(casaCentro).toBeDefined();
      expect(Number(casaCentro!.preco)).toBe(480000);
    } finally {
      conexao3.release();
    }
  });

  it("limite corta a quantidade de linhas", async () => {
    const pool = obterPoolMysql(conexaoDe(banco, { sslMode: "disable" }));
    const { sql, valores } = RECEITA_ACF_IMOVEIS.montar(
      {
        prefixo: WP_PREFIXO,
        post_type: "imovel",
        campos: { preco: "preco", quartos: "quartos", bairro: "bairro" },
      },
      { limite: 2 },
      2,
    );
    const conexao = await pool.getConnection();
    try {
      await conexao.query("START TRANSACTION READ ONLY");
      await conexao.query("SET SESSION max_execution_time = 10000");
      await conexao.query("SET SESSION lock_wait_timeout = 5");
      const [linhas] = await conexao.execute(
        sql,
        valores.map((v: unknown) => (v === undefined ? null : v)),
      );
      await conexao.query("COMMIT");
      expect((linhas as { id: number }[]).length).toBeLessThanOrEqual(2);
    } finally {
      conexao.release();
    }
  });

  it("rascunho nunca aparece (post_status = publish)", async () => {
    const pool = obterPoolMysql(conexaoDe(banco, { sslMode: "disable" }));
    const { sql, valores } = RECEITA_ACF_IMOVEIS.montar(
      {
        prefixo: WP_PREFIXO,
        post_type: "imovel",
        campos: { preco: "preco", quartos: "quartos", bairro: "bairro" },
      },
      {},
      5,
    );
    const conexao = await pool.getConnection();
    try {
      await conexao.query("START TRANSACTION READ ONLY");
      await conexao.query("SET SESSION max_execution_time = 10000");
      await conexao.query("SET SESSION lock_wait_timeout = 5");
      const [linhas] = await conexao.execute(
        sql,
        valores.map((v: unknown) => (v === undefined ? null : v)),
      );
      await conexao.query("COMMIT");
      const titulos = (linhas as { titulo: string }[]).map((l) => l.titulo);
      expect(titulos).not.toContain("Rascunho invisível");
    } finally {
      conexao.release();
    }
  });

  it("outro post_type (post) nunca aparece", async () => {
    const pool = obterPoolMysql(conexaoDe(banco, { sslMode: "disable" }));
    const { sql, valores } = RECEITA_ACF_IMOVEIS.montar(
      {
        prefixo: WP_PREFIXO,
        post_type: "imovel",
        campos: { preco: "preco", quartos: "quartos", bairro: "bairro" },
      },
      {},
      5,
    );
    const conexao = await pool.getConnection();
    try {
      await conexao.query("START TRANSACTION READ ONLY");
      await conexao.query("SET SESSION max_execution_time = 10000");
      await conexao.query("SET SESSION lock_wait_timeout = 5");
      const [linhas] = await conexao.execute(
        sql,
        valores.map((v: unknown) => (v === undefined ? null : v)),
      );
      await conexao.query("COMMIT");
      const titulos = (linhas as { titulo: string }[]).map((l) => l.titulo);
      expect(titulos).not.toContain("Artigo do blog");
    } finally {
      conexao.release();
    }
  });

  it("mapeamento com nomes diferentes (valor/dormitorios) funciona", async () => {
    const pool = obterPoolMysql(conexaoDe(banco, { sslMode: "disable" }));
    // O mesmo banco, mas a receita usa meta_key "valor" e "dormitorios" em vez de "preco"/"quartos".
    // Para isso criamos cópias das metas com nomes alternativos num prefixo diferente.
    const ALT_PREFIXO = "loja_";
    await root.query(
      `create table \`${banco}\`.\`${ALT_PREFIXO}posts\` like \`${banco}\`.\`${WP_PREFIXO}posts\``,
    );
    await root.query(
      `create table \`${banco}\`.\`${ALT_PREFIXO}postmeta\` like \`${banco}\`.\`${WP_PREFIXO}postmeta\``,
    );
    // Copia só os posts do tipo imovel publicados.
    await root.query(
      `insert into \`${banco}\`.\`${ALT_PREFIXO}posts\` select * from \`${banco}\`.\`${WP_PREFIXO}posts\` where post_type = 'imovel' and post_status = 'publish'`,
    );
    // Copia as metas, renomeando preco->valor e quartos->dormitorios.
    await root.query(
      `insert into \`${banco}\`.\`${ALT_PREFIXO}postmeta\` (post_id, meta_key, meta_value)
       select post_id,
         case meta_key when 'preco' then 'valor' when 'quartos' then 'dormitorios' else meta_key end,
         meta_value
       from \`${banco}\`.\`${WP_PREFIXO}postmeta\`
       where post_id in (select ID from \`${banco}\`.\`${ALT_PREFIXO}posts\`)`,
    );
    const { sql, valores } = RECEITA_ACF_IMOVEIS.montar(
      {
        prefixo: ALT_PREFIXO,
        post_type: "imovel",
        campos: { preco: "valor", quartos: "dormitorios", bairro: "bairro" },
      },
      { preco_max: 600000 },
      5,
    );
    const conexao = await pool.getConnection();
    try {
      await conexao.query("START TRANSACTION READ ONLY");
      await conexao.query("SET SESSION max_execution_time = 10000");
      await conexao.query("SET SESSION lock_wait_timeout = 5");
      const [linhas] = await conexao.execute(
        sql,
        valores.map((v: unknown) => (v === undefined ? null : v)),
      );
      await conexao.query("COMMIT");
      const titulos = (linhas as { titulo: string }[]).map((l) => l.titulo);
      registrar("C1-acf-imoveis-mapeamento", `valor/dormitorios → ${titulos.join(", ")}`);
      expect(titulos).toContain("Casa Centro"); // 480000 <= 600000
      expect(titulos).toContain("Apartamento 2 quartos"); // 300000 <= 600000
    } finally {
      conexao.release();
    }
    await root.query(`drop table if exists \`${banco}\`.\`${ALT_PREFIXO}posts\``);
    await root.query(`drop table if exists \`${banco}\`.\`${ALT_PREFIXO}postmeta\``);
  });

  it("fonte_nao_liberada em modo list quando a tabela da receita não está na lista", async () => {
    const regra = { modo: "list" as const, fontes: [] };
    const d = criarDialetoDeLeitura(
      {
        listarTabelas: async () => [],
        descreverTabela: async () => null,
        lerTabela: async () => ({ colunas: [], linhas: [], limite: 5, offset: 0 }),
        schemaDasReceitas: () => banco,
        executarReceita: async () => ({
          colunas: [],
          linhas: [],
          limite: 5,
          offset: 0,
          truncado: false,
        }),
      },
      regra,
    );
    const { sql, valores } = RECEITA_ACF_IMOVEIS.montar(
      {
        prefixo: WP_PREFIXO,
        post_type: "imovel",
        campos: { preco: "preco", quartos: "quartos", bairro: "bairro" },
      },
      {},
      5,
    );
    await expect(
      d.executarReceita(
        {
          sql,
          valores,
          tabelas: RECEITA_ACF_IMOVEIS.tabelas(WP_PREFIXO),
          colunasPorTabela: RECEITA_ACF_IMOVEIS.colunas(WP_PREFIXO),
        },
        { limiteMax: 5 },
      ),
    ).rejects.toBeInstanceOf(FonteNaoLiberadaError);
  });
});
