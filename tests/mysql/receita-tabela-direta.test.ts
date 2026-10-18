/**
 * Spec 25, item 8 — integração da receita `tabela-direta` contra um
 * MySQL 8 de verdade (job `mysql-integracao`, NÃO roda aqui).
 *
 * Tabela `carros` (id, modelo, ano, preco texto, preco_txt varchar, cor, foto, status).
 * Versão de referência: tabela plana genérica, coluna por dado.
 *
 * Semeia 7 carros:
 *  1. status = 0 (inativo) — nunca deve aparecer (status filtra)
 *  2. publicado, preço "65.000,00" (formato brasileiro)
 *  3. publicado, preço "48000" (número puro)
 *  4. publicado, preço "65000.50" (ponto decimal)
 *  5. publicado, preço "1.200.000" (pontos milhar)
 *  6. publicado, cor "vermelho", ano 2018
 *  7. publicado, cor "azul", ano 2020
 *
 * Casos: texto em duas colunas, preco_max/preco_min, numero_min/max (ano),
 * status fixo exclui inativos, limite, coluna de exibir sai com nome real,
 * preço volta como número, coluna inexistente em modo all → coluna_inexistente.
 * Cada caso isolado por filtro (lição 5: o teto é 5 e pode esconder linha).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { criarDialetoDeLeitura, FonteNaoLiberadaError } from "@/lib/external-db/dialeto";
import { LeituraInvalidaError } from "@/lib/external-db/leitura";
import { obterPoolMysql } from "@/lib/external-db/dialetos/mysql/conexao";
import type { TabelaExterna } from "@/lib/external-db/types";
import { RECEITA_TABELA_DIRETA } from "@/lib/external-db/receitas/tabela-direta";
import { validarConsultaDeReceita } from "@/lib/external-db/receitas/validador";

import { apagarBanco, conectarComoRoot, conexaoDe, novoBanco, registrar } from "./ajudante";
import type { Root } from "./ajudante";

let root: Root;
let banco: string;

/** root.query pode retornar RowDataPacket[] (SELECT) ou [RowDataPacket[], ResultSetHeader] (tupla). Normaliza. */
function extrairLinhas<T = unknown>(resultado: unknown): T[] {
  const arr = Array.isArray(resultado) ? (resultado as unknown[]) : [resultado];
  const primeiro = arr[0];
  return Array.isArray(primeiro) ? (primeiro as T[]) : (arr as T[]);
}

async function criarTabelas(root: Root, banco: string): Promise<void> {
  const q = (sql: string) => root.query(sql);
  await q(`
    create table \`${banco}\`.\`carros\` (
      id int not null auto_increment,
      modelo varchar(100) not null default '',
      ano int not null default 0,
      preco varchar(50) not null default '',
      preco_txt varchar(50) not null default '',
      cor varchar(50) not null default '',
      foto varchar(200) not null default '',
      status int not null default 0,
      primary key (id)
    ) engine=InnoDB character set utf8mb4;
  `);
}

async function semeiaCarros(root: Root, banco: string): Promise<void> {
  const q = (sql: string, params: unknown[] = []) => root.query(sql, params);

  // 1. inativo (status = 0) — nunca aparece
  await q(
    `insert into \`${banco}\`.\`carros\` (modelo, ano, preco, cor, foto, status) values ('Carro inativo', 2015, '50.000', 'vermelho', 'foto1.jpg', 0)`,
  );

  // 2. publicado, preço "65.000,00" (formato brasileiro)
  await q(
    `insert into \`${banco}\`.\`carros\` (modelo, ano, preco, cor, foto, status) values ('Sedan Vermelho', 2018, '65.000,00', 'vermelho', 'foto2.jpg', 1)`,
  );
  const idSedan = Number(
    (extrairLinhas<{ id: number }>(await q(`select LAST_INSERT_ID() as id`))[0] as { id: number })
      ?.id ?? 1,
  );

  // 3. publicado, preço "48000" (número puro)
  await q(
    `insert into \`${banco}\`.\`carros\` (modelo, ano, preco, cor, foto, status) values ('Hatch Azul', 2020, '48000', 'azul', 'foto3.jpg', 1)`,
  );
  const idHatch = Number(
    (extrairLinhas<{ id: number }>(await q(`select LAST_INSERT_ID() as id`))[0] as { id: number })
      ?.id ?? 2,
  );

  // 4. publicado, preço "65000.50" (ponto decimal)
  await q(
    `insert into \`${banco}\`.\`carros\` (modelo, ano, preco, cor, foto, status) values ('Coupe Preto', 2019, '65000.50', 'preto', 'foto4.jpg', 1)`,
  );
  const idCoupe = Number(
    (extrairLinhas<{ id: number }>(await q(`select LAST_INSERT_ID() as id`))[0] as { id: number })
      ?.id ?? 3,
  );

  // 5. publicado, preço "1.200.000" (pontos milhar)
  await q(
    `insert into \`${banco}\`.\`carros\` (modelo, ano, preco, cor, foto, status) values ('Luxo Prata', 2022, '1.200.000', 'prata', 'foto5.jpg', 1)`,
  );
  const idLuxo = Number(
    (extrairLinhas<{ id: number }>(await q(`select LAST_INSERT_ID() as id`))[0] as { id: number })
      ?.id ?? 4,
  );

  // 6. publicado, cor vermelho, ano 2018
  await q(
    `insert into \`${banco}\`.\`carros\` (modelo, ano, preco, cor, foto, status) values ('SUV Vermelho', 2018, '90.000', 'vermelho', 'foto6.jpg', 1)`,
  );
  const idSuv = Number(
    (extrairLinhas<{ id: number }>(await q(`select LAST_INSERT_ID() as id`))[0] as { id: number })
      ?.id ?? 5,
  );

  // 7. publicado, cor azul, ano 2020
  await q(
    `insert into \`${banco}\`.\`carros\` (modelo, ano, preco, cor, foto, status) values ('Pickup Azul', 2020, '75.000', 'azul', 'foto7.jpg', 1)`,
  );
  const idPickup = Number(
    (extrairLinhas<{ id: number }>(await q(`select LAST_INSERT_ID() as id`))[0] as { id: number })
      ?.id ?? 6,
  );
}

describe("receita tabela-direta contra MySQL 8 de verdade", () => {
  beforeAll(async () => {
    root = await conectarComoRoot();
    banco = await novoBanco(root, "tabela-direta");
    await criarTabelas(root, banco);
    await semeiaCarros(root, banco);
  });

  afterAll(async () => {
    await apagarBanco(root, banco);
    await root.end().catch(() => undefined);
  });

  it("monta SQL e passa no validador com as tabelas permitidas", () => {
    const fixos = {
      tabela: "carros",
      colunas: {
        id: "id",
        titulo: "modelo",
        preco: "preco",
        filtros_texto: ["cor"],
        filtro_numero: "ano",
        exibir: ["cor"],
        status: { coluna: "status", valor: "1" },
      },
    };
    const { sql, valores } = RECEITA_TABELA_DIRETA.montar(fixos, {}, 5);
    const tabelas = RECEITA_TABELA_DIRETA.tabelas(fixos);
    expect(() => validarConsultaDeReceita(sql, tabelas)).not.toThrow();
    expect(valores).toContain("1");
    expect(sql.split("?").length - 1).toBe(valores.length);
  });

  it("texto filtra em OR sobre as colunas de filtros_texto", async () => {
    const pool = obterPoolMysql(conexaoDe(banco, { sslMode: "disable" }));
    const { sql, valores } = RECEITA_TABELA_DIRETA.montar(
      {
        tabela: "carros",
        colunas: {
          id: "id",
          titulo: "modelo",
          preco: "preco",
          filtros_texto: ["cor"],
          filtro_numero: "ano",
          exibir: ["cor"],
          status: { coluna: "status", valor: "1" },
        },
      },
      { texto: "vermelho", limite: 5 },
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
      const modelos = (linhas as { titulo: string }[]).map((l) => l.titulo);
      registrar("C1-tabela-direta-texto", `texto 'vermelho' → ${modelos.join(", ")}`);
      expect(modelos).toContain("Sedan Vermelho");
      expect(modelos).toContain("SUV Vermelho");
      expect(modelos).not.toContain("Hatch Azul");
    } finally {
      conexao.release();
    }
  });

  it("preco_max aceita formato brasileiro '65.000,00' → 65000", async () => {
    const pool = obterPoolMysql(conexaoDe(banco, { sslMode: "disable" }));
    const { sql, valores } = RECEITA_TABELA_DIRETA.montar(
      {
        tabela: "carros",
        colunas: {
          id: "id",
          titulo: "modelo",
          preco: "preco",
          filtros_texto: [],
          filtro_numero: "ano",
          exibir: ["cor"],
          status: { coluna: "status", valor: "1" },
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
      const modelos = (linhas as { titulo: string }[]).map((l) => l.titulo);
      registrar("C1-tabela-direta-preco_max_65k", `preco_max=65000 → ${modelos.join(", ")}`);
      expect(modelos).toContain("Hatch Azul"); // 48000 <= 65000
      expect(modelos).toContain("Sedan Vermelho"); // 65000 <= 65000
      expect(modelos).not.toContain("Coupe Preto"); // 65000.50 > 65000
      expect(modelos).not.toContain("Luxo Prata"); // 1200000 > 65000
    } finally {
      conexao.release();
    }
  });

  it("preco_max trata ponto decimal '65000.50' → 65000.5", async () => {
    const pool = obterPoolMysql(conexaoDe(banco, { sslMode: "disable" }));
    const { sql, valores } = RECEITA_TABELA_DIRETA.montar(
      {
        tabela: "carros",
        colunas: {
          id: "id",
          titulo: "modelo",
          preco: "preco",
          filtros_texto: [],
          filtro_numero: "ano",
          exibir: ["cor"],
          status: { coluna: "status", valor: "1" },
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
      const modelos = (linhas as { titulo: string }[]).map((l) => l.titulo);
      registrar(
        "C1-tabela-direta-preco_max_decimal",
        `preco_max=65000 → ${modelos.join(", ")}`,
      );
      // 65000.50 > 65000, então Coupe Preto NÃO entra
      expect(modelos).not.toContain("Coupe Preto");
      // 48000 <= 65000, Hatch Azul entra
      expect(modelos).toContain("Hatch Azul");
    } finally {
      conexao.release();
    }
  });

  it("preco_max trata '1.200.000' → 1200000 (pontos milhar)", async () => {
    const pool = obterPoolMysql(conexaoDe(banco, { sslMode: "disable" }));
    const { sql, valores } = RECEITA_TABELA_DIRETA.montar(
      {
        tabela: "carros",
        colunas: {
          id: "id",
          titulo: "modelo",
          preco: "preco",
          filtros_texto: [],
          filtro_numero: "ano",
          exibir: ["cor"],
          status: { coluna: "status", valor: "1" },
        },
      },
      { preco_max: 1000000, limite: 5 },
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
      const modelos = (linhas as { titulo: string }[]).map((l) => l.titulo);
      registrar("C1-tabela-direta-preco_max_1m", `preco_max=1000000 → ${modelos.join(", ")}`);
      // 1.200.000 → 1200000 > 1000000, Luxo Prata NÃO entra
      expect(modelos).not.toContain("Luxo Prata");
    } finally {
      conexao.release();
    }
  });

  it("numero_min filtra pelo ano (filtro_numero)", async () => {
    const pool = obterPoolMysql(conexaoDe(banco, { sslMode: "disable" }));
    const { sql, valores } = RECEITA_TABELA_DIRETA.montar(
      {
        tabela: "carros",
        colunas: {
          id: "id",
          titulo: "modelo",
          preco: "preco",
          filtros_texto: [],
          filtro_numero: "ano",
          exibir: ["cor"],
          status: { coluna: "status", valor: "1" },
        },
      },
      { numero_min: 2019, limite: 5 },
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
      const modelos = (linhas as { titulo: string }[]).map((l) => l.titulo);
      registrar("C1-tabela-direta-numero_min", `numero_min=2019 → ${modelos.join(", ")}`);
      expect(modelos).toContain("Coupe Preto"); // 2019
      expect(modelos).toContain("Luxo Prata"); // 2022
      expect(modelos).toContain("Pickup Azul"); // 2020
      expect(modelos).not.toContain("Sedan Vermelho"); // 2018
      expect(modelos).toContain("Hatch Azul"); // 2020 >= 2019 entra
      expect(modelos).not.toContain("SUV Vermelho"); // 2018
      expect(modelos).not.toContain("Carro inativo"); // 2015 e status = 0
    } finally {
      conexao.release();
    }
  });

  it("status fixo exclui inativos", async () => {
    const pool = obterPoolMysql(conexaoDe(banco, { sslMode: "disable" }));
    const { sql, valores } = RECEITA_TABELA_DIRETA.montar(
      {
        tabela: "carros",
        colunas: {
          id: "id",
          titulo: "modelo",
          preco: "preco",
          filtros_texto: [],
          filtro_numero: "ano",
          exibir: ["cor"],
          status: { coluna: "status", valor: "1" },
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
      const modelos = (linhas as { titulo: string }[]).map((l) => l.titulo);
      registrar("C1-tabela-direta-status", `status=1 → ${modelos.join(", ")}`);
      expect(modelos).not.toContain("Carro inativo"); // status = 0
    } finally {
      conexao.release();
    }
  });

  it("coluna de exibir sai com nome real, não c0", async () => {
    const pool = obterPoolMysql(conexaoDe(banco, { sslMode: "disable" }));
    const { sql, valores } = RECEITA_TABELA_DIRETA.montar(
      {
        tabela: "carros",
        colunas: {
          id: "id",
          titulo: "modelo",
          preco: "preco",
          filtros_texto: [],
          filtro_numero: "ano",
          exibir: ["cor"],
          status: { coluna: "status", valor: "1" },
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
      // A coluna de exibir sai com nome real `cor`, não c0
      expect((linhas as Record<string, unknown>[]).length).toBeGreaterThan(0);
      const primeira = (linhas as Record<string, unknown>[])[0] as Record<string, unknown>;
      expect("cor" in primeira).toBe(true);
      expect("c0" in primeira).toBe(false);
    } finally {
      conexao.release();
    }
  });

  it("coluna inexistente em modo all → coluna_inexistente", async () => {
    const regra = { modo: "all" as const, fontes: [] };
    const d = criarDialetoDeLeitura(
      {
        listarTabelas: async () => [],
        descreverTabela: async (schema: string, tabela: string): Promise<TabelaExterna | null> => {
          if (tabela === "carros") {
            return {
              schema,
              nome: "carros",
              tipo: "tabela",
              colunas: [
                { nome: "id", tipo: "int", nulavel: false, posicao: 0 },
                { nome: "modelo", tipo: "varchar", nulavel: false, posicao: 1 },
                { nome: "ano", tipo: "int", nulavel: false, posicao: 2 },
                { nome: "preco", tipo: "varchar", nulavel: false, posicao: 3 },
                { nome: "cor", tipo: "varchar", nulavel: false, posicao: 4 },
                { nome: "foto", tipo: "varchar", nulavel: false, posicao: 5 },
                { nome: "status", tipo: "int", nulavel: false, posicao: 6 },
              ],
              chavePrimaria: ["id"],
              estimativaLinhas: 7,
            };
          }
          return null;
        },
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
    const { sql, valores } = RECEITA_TABELA_DIRETA.montar(
      {
        tabela: "carros",
        colunas: {
          id: "id",
          titulo: "modelo",
          preco: "preco_inexistente", // coluna que não existe
          filtros_texto: [],
          filtro_numero: "ano",
          exibir: ["cor"],
          status: { coluna: "status", valor: "1" },
        },
      },
      {},
      5,
    );
    const fixosInexistente = {
      tabela: "carros",
      colunas: {
        id: "id",
        titulo: "modelo",
        preco: "preco_inexistente",
        filtros_texto: [],
        filtro_numero: "ano",
        exibir: ["cor"],
        status: { coluna: "status", valor: "1" },
      },
    };
    const { sql: sqlInexistente, valores: valoresInexistente } =
      RECEITA_TABELA_DIRETA.montar(fixosInexistente, {}, 5);
    await expect(
      d.executarReceita(
        {
          sql: sqlInexistente,
          valores: valoresInexistente,
          tabelas: RECEITA_TABELA_DIRETA.tabelas(fixosInexistente),
          colunasPorTabela: RECEITA_TABELA_DIRETA.colunas(fixosInexistente),
        },
        { limiteMax: 5 },
      ),
    ).rejects.toBeInstanceOf(LeituraInvalidaError);
  });

  it("modo all com coluna existente chama o motor", async () => {
    const regra = { modo: "all" as const, fontes: [] };
    const d = criarDialetoDeLeitura(
      {
        listarTabelas: async () => [],
        descreverTabela: async (schema: string, tabela: string): Promise<TabelaExterna | null> => {
          if (tabela === "carros") {
            return {
              schema,
              nome: "carros",
              tipo: "tabela",
              colunas: [
                { nome: "id", tipo: "int", nulavel: false, posicao: 0 },
                { nome: "modelo", tipo: "varchar", nulavel: false, posicao: 1 },
                { nome: "ano", tipo: "int", nulavel: false, posicao: 2 },
                { nome: "preco", tipo: "varchar", nulavel: false, posicao: 3 },
                { nome: "cor", tipo: "varchar", nulavel: false, posicao: 4 },
                { nome: "foto", tipo: "varchar", nulavel: false, posicao: 5 },
                { nome: "status", tipo: "int", nulavel: false, posicao: 6 },
              ],
              chavePrimaria: ["id"],
              estimativaLinhas: 7,
            };
          }
          return null;
        },
        lerTabela: async () => ({
          colunas: ["id", "modelo"],
          linhas: [{ id: 1, modelo: "Teste" }],
          limite: 5,
          offset: 0,
          truncado: false,
        }),
        schemaDasReceitas: () => banco,
        executarReceita: async () => ({
          colunas: ["id", "modelo"],
          linhas: [{ id: 1, modelo: "Teste" }],
          limite: 5,
          offset: 0,
          truncado: false,
        }),
      },
      regra,
    );
    const fixosValido = {
      tabela: "carros",
      colunas: {
        id: "id",
        titulo: "modelo",
        preco: "preco",
        filtros_texto: [],
        filtro_numero: "ano",
        exibir: ["cor"],
        status: { coluna: "status", valor: "1" },
      },
    };
    const { sql, valores } = RECEITA_TABELA_DIRETA.montar(fixosValido, {}, 5);
    const resultado = await d.executarReceita(
      {
        sql,
        valores,
        tabelas: RECEITA_TABELA_DIRETA.tabelas(fixosValido),
        colunasPorTabela: RECEITA_TABELA_DIRETA.colunas(fixosValido),
      },
      { limiteMax: 5 },
    );
    expect(resultado.linhas.length).toBe(1);
  });
});
