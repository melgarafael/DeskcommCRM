/**
 * Spec 25, item 8 — integração da receita `jetengine-imoveis` contra um
 * MySQL 8 de verdade (job `mysql-integracao`, NÃO roda aqui).
 *
 * Tabela `wp_jet_cct_imoveis` com colunas do JetEngine 3.x:
 * _ID, cct_status, cct_author_id, cct_created, cct_modified +
 * campos de imóvel: titulo, preco, quartos, bairro, cidade, area.
 *
 * DDL INFERIDO da documentação do JetEngine 3.x, NÃO medido contra uma
 * instalação real. A medição contra cópia real (C1 JetEngine) está pendente.
 *
 * Semeia 6 imóveis:
 *  1. rascunho (cct_status = 'draft') — nunca deve aparecer
 *  2. publicado, bairro "Asa Norte", preço "65.000,00", quartos 3
 *  3. publicado, bairro "Centro", preço "48000", quartos 2
 *  4. publicado, bairro "Asa Norte", preço "65000.50", quartos 4
 *  5. publicado, bairro "Centro", preço "1.200.000", quartos 3
 *  6. publicado, bairro "Lago Sul", preço "90.000", quartos 2
 *
 * Casos: draft não aparece, bairro e cidade em AND (cada um na sua coluna),
 * quartos_min, preco_max, área sai com nome real.
 * Cada caso isolado por filtro (lição 5: o teto é 5 e pode esconder linha).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { criarDialetoDeLeitura, FonteNaoLiberadaError } from "@/lib/external-db/dialeto";
import { LeituraInvalidaError } from "@/lib/external-db/leitura";
import { obterPoolMysql } from "@/lib/external-db/dialetos/mysql/conexao";
import type { TabelaExterna } from "@/lib/external-db/types";
import { RECEITA_JETENGINE_IMOVEIS } from "@/lib/external-db/receitas/jetengine-imoveis";
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

async function criarTabelasJetEngine(root: Root, banco: string): Promise<void> {
  const q = (sql: string) => root.query(sql);
  await q(`
    create table \`${banco}\`.\`${WP_PREFIXO}jet_cct_imoveis\` (
      _ID bigint unsigned not null auto_increment,
      cct_status varchar(20) not null default 'draft',
      cct_author_id bigint unsigned not null default 0,
      cct_created datetime not null default current_timestamp,
      cct_modified datetime not null default current_timestamp on update current_timestamp,
      titulo varchar(200) not null default '',
      preco varchar(50) not null default '',
      quartos int not null default 0,
      bairro varchar(100) not null default '',
      cidade varchar(100) not null default '',
      area varchar(50) not null default '',
      primary key (_ID),
      key cct_status (cct_status),
      key bairro (bairro),
      key cidade (cidade)
    ) engine=InnoDB character set utf8mb4;
  `);
}

async function semeiaImoveis(root: Root, banco: string): Promise<void> {
  const q = (sql: string, params: unknown[] = []) => root.query(sql, params);

  // 1. rascunho (cct_status = 'draft') — nunca aparece
  await q(
    `insert into \`${banco}\`.\`${WP_PREFIXO}jet_cct_imoveis\` (_ID, cct_status, cct_author_id, cct_created, cct_modified, titulo, preco, quartos, bairro, cidade, area) values (1, 'draft', 1, '2024-01-01 00:00:00', '2024-01-01 00:00:00', 'Rascunho invisível', '50.000', 2, 'Bairro Rascunho', 'Cidade Rascunho', '100m2')`,
  );

  // 2. publicado, bairro "Asa Norte", preço "65.000,00", quartos 3
  await q(
    `insert into \`${banco}\`.\`${WP_PREFIXO}jet_cct_imoveis\` (_ID, cct_status, cct_author_id, cct_created, cct_modified, titulo, preco, quartos, bairro, cidade, area) values (2, 'publish', 1, '2024-01-01 00:00:00', '2024-01-01 00:00:00', 'Apartamento Asa Norte', '65.000,00', 3, 'Asa Norte', 'Asa Norte', '80m2')`,
  );
  const idAsaNorte = Number(
    (extrairLinhas<{ _ID: number }>(await q(`select LAST_INSERT_ID() as _ID`))[0] as { _ID: number })
      ?._ID ?? 2,
  );

  // 3. publicado, bairro "Centro", preço "48000", quartos 2
  await q(
    `insert into \`${banco}\`.\`${WP_PREFIXO}jet_cct_imoveis\` (_ID, cct_status, cct_author_id, cct_created, cct_modified, titulo, preco, quartos, bairro, cidade, area) values (3, 'publish', 1, '2024-01-01 00:00:00', '2024-01-01 00:00:00', 'Casa Centro', '48000', 2, 'Centro', 'Centro', '60m2')`,
  );
  const idCentro = Number(
    (extrairLinhas<{ _ID: number }>(await q(`select LAST_INSERT_ID() as _ID`))[0] as { _ID: number })
      ?._ID ?? 3,
  );

  // 4. publicado, bairro "Asa Norte", preço "65000.50", quartos 4
  await q(
    `insert into \`${banco}\`.\`${WP_PREFIXO}jet_cct_imoveis\` (_ID, cct_status, cct_author_id, cct_created, cct_modified, titulo, preco, quartos, bairro, cidade, area) values (4, 'publish', 1, '2024-01-01 00:00:00', '2024-01-01 00:00:00', 'Cobertura Decimal', '65000.50', 4, 'Asa Norte', 'Asa Norte', '120m2')`,
  );
  const idDecimal = Number(
    (extrairLinhas<{ _ID: number }>(await q(`select LAST_INSERT_ID() as _ID`))[0] as { _ID: number })
      ?._ID ?? 4,
  );

  // 5. publicado, bairro "Centro", preço "1.200.000", quartos 3
  await q(
    `insert into \`${banco}\`.\`${WP_PREFIXO}jet_cct_imoveis\` (_ID, cct_status, cct_author_id, cct_created, cct_modified, titulo, preco, quartos, bairro, cidade, area) values (5, 'publish', 1, '2024-01-01 00:00:00', '2024-01-01 00:00:00', 'Casa Milhar', '1.200.000', 3, 'Centro', 'Centro', '200m2')`,
  );
  const idMilhar = Number(
    (extrairLinhas<{ _ID: number }>(await q(`select LAST_INSERT_ID() as _ID`))[0] as { _ID: number })
      ?._ID ?? 5,
  );

  // 6. publicado, bairro "Lago Sul", preço "90.000", quartos 2
  await q(
    `insert into \`${banco}\`.\`${WP_PREFIXO}jet_cct_imoveis\` (_ID, cct_status, cct_author_id, cct_created, cct_modified, titulo, preco, quartos, bairro, cidade, area) values (6, 'publish', 1, '2024-01-01 00:00:00', '2024-01-01 00:00:00', 'Casa Lago Sul', '90.000', 2, 'Lago Sul', 'Lago Sul', '150m2')`,
  );
  const idLagoSul = Number(
    (extrairLinhas<{ _ID: number }>(await q(`select LAST_INSERT_ID() as _ID`))[0] as { _ID: number })
      ?._ID ?? 6,
  );
}

describe("receita jetengine-imoveis contra MySQL 8 de verdade", () => {
  beforeAll(async () => {
    root = await conectarComoRoot();
    banco = await novoBanco(root, "jetengine-imoveis");
    await criarTabelasJetEngine(root, banco);
    await semeiaImoveis(root, banco);
  });

  afterAll(async () => {
    await apagarBanco(root, banco);
    await root.end().catch(() => undefined);
  });

  it("monta SQL e passa no validador com as tabelas permitidas", () => {
    const { sql, valores } = RECEITA_JETENGINE_IMOVEIS.montar(
      {
        prefixo: WP_PREFIXO,
        slug: "imoveis",
        campos: {
          preco: "preco",
          quartos: "quartos",
          bairro: "bairro",
          titulo: "titulo",
          cidade: "cidade",
          area: "area",
        },
      },
      {},
      5,
    );
    const tabelas = RECEITA_JETENGINE_IMOVEIS.tabelas({
      prefixo: WP_PREFIXO,
      slug: "imoveis",
      campos: {
        preco: "preco",
        quartos: "quartos",
        bairro: "bairro",
        titulo: "titulo",
        cidade: "cidade",
        area: "area",
      },
    });
    expect(() => validarConsultaDeReceita(sql, tabelas)).not.toThrow();
    expect(valores).toContain("publish");
    expect(sql.split("?").length - 1).toBe(valores.length);
  });

  it("draft não aparece (cct_status = 'publish')", async () => {
    const pool = obterPoolMysql(conexaoDe(banco, { sslMode: "disable" }));
    const { sql, valores } = RECEITA_JETENGINE_IMOVEIS.montar(
      {
        prefixo: WP_PREFIXO,
        slug: "imoveis",
        campos: {
          preco: "preco",
          quartos: "quartos",
          bairro: "bairro",
          titulo: "titulo",
          cidade: "cidade",
          area: "area",
        },
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
      registrar("C1-jetengine-draft", `draft → ${titulos.join(", ")}`);
      expect(titulos).not.toContain("Rascunho invisível");
    } finally {
      conexao.release();
    }
  });

  it("bairro + cidade em AND, cada valor na sua coluna", async () => {
    const pool = obterPoolMysql(conexaoDe(banco, { sslMode: "disable" }));
    const { sql, valores } = RECEITA_JETENGINE_IMOVEIS.montar(
      {
        prefixo: WP_PREFIXO,
        slug: "imoveis",
        campos: {
          preco: "preco",
          quartos: "quartos",
          bairro: "bairro",
          titulo: "titulo",
          cidade: "cidade",
          area: "area",
        },
      },
      { bairro: "asa norte", cidade: "asa norte", limite: 5 },
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
      registrar(
        "C1-jetengine-bairro_cidade",
        `bairro='asa norte' AND cidade='asa norte' → ${titulos.join(", ")}`,
      );
      expect(titulos).toContain("Apartamento Asa Norte");
      expect(titulos).toContain("Cobertura Decimal"); // também Asa Norte
      expect(titulos).not.toContain("Casa Centro"); // Centro, não Asa Norte
    } finally {
      conexao.release();
    }
  });

  it("quartos_min filtra pelo ano (filtro_numero)", async () => {
    const pool = obterPoolMysql(conexaoDe(banco, { sslMode: "disable" }));
    const { sql, valores } = RECEITA_JETENGINE_IMOVEIS.montar(
      {
        prefixo: WP_PREFIXO,
        slug: "imoveis",
        campos: {
          preco: "preco",
          quartos: "quartos",
          bairro: "bairro",
          titulo: "titulo",
          cidade: "cidade",
          area: "area",
        },
      },
      { quartos_min: 3, limite: 5 },
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
      registrar("C1-jetengine-quartos_min", `quartos_min=3 → ${titulos.join(", ")}`);
      expect(titulos).toContain("Apartamento Asa Norte"); // 3
      expect(titulos).toContain("Casa Milhar"); // 3
      expect(titulos).not.toContain("Casa Centro"); // 2
      expect(titulos).not.toContain("Casa Lago Sul"); // 2
    } finally {
      conexao.release();
    }
  });

  it("preco_max aceita formato brasileiro '65.000,00' → 65000", async () => {
    const pool = obterPoolMysql(conexaoDe(banco, { sslMode: "disable" }));
    const { sql, valores } = RECEITA_JETENGINE_IMOVEIS.montar(
      {
        prefixo: WP_PREFIXO,
        slug: "imoveis",
        campos: {
          preco: "preco",
          quartos: "quartos",
          bairro: "bairro",
          titulo: "titulo",
          cidade: "cidade",
          area: "area",
        },
      },
      { preco_max: 65000, limite: 5 },
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
      registrar("C1-jetengine-preco_max_65k", `preco_max=65000 → ${titulos.join(", ")}`);
      expect(titulos).toContain("Casa Centro"); // 48000 <= 65000
      expect(titulos).toContain("Apartamento Asa Norte"); // 65000 <= 65000
      expect(titulos).not.toContain("Cobertura Decimal"); // 65000.50 > 65000
      expect(titulos).not.toContain("Casa Milhar"); // 1200000 > 65000
    } finally {
      conexao.release();
    }
  });

  it("área sai com nome real, não c0", async () => {
    const pool = obterPoolMysql(conexaoDe(banco, { sslMode: "disable" }));
    const { sql, valores } = RECEITA_JETENGINE_IMOVEIS.montar(
      {
        prefixo: WP_PREFIXO,
        slug: "imoveis",
        campos: {
          preco: "preco",
          quartos: "quartos",
          bairro: "bairro",
          titulo: "titulo",
          cidade: "cidade",
          area: "area",
        },
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
      expect((linhas as Record<string, unknown>[]).length).toBeGreaterThan(0);
      const primeira = (linhas as Record<string, unknown>[])[0] as Record<string, unknown>;
      expect("area" in primeira).toBe(true);
      expect("c0" in primeira).toBe(false);
    } finally {
      conexao.release();
    }
  });
});
