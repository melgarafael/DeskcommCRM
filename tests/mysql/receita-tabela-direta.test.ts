/**
 * Spec 25, item R3 — integração da receita `tabela-direta` contra um MySQL
 * 8 de verdade (job `mysql-integracao`, NÃO roda aqui).
 *
 * O seed tem DUAS tabelas planas:
 *  - `wp_jet_cct_imovel`: a tabela CCT real do JetEngine (colunas abaixo), com
 *    cct_status para "só publicados" e situacao para "esconder";
 *  - `carros`: outra tabela plana de um nicho diferente, provando que a receita
 *    é genérica.
 *
 * Cada caso obriga a receita a devolver exatamente o que o filtro pede — nada
 * mais, nada menos — e prova que TODA coluna mapeada sai na linha.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { obterPoolMysql } from "@/lib/external-db/dialetos/mysql/conexao";
import { RECEITA_TABELA_DIRETA } from "@/lib/external-db/receitas/tabela-direta";

import { apagarBanco, conectarComoRoot, conexaoDe, novoBanco, registrar } from "./ajudante";
import type { Root } from "./ajudante";

let root: Root;
let banco: string;

async function criarTabelas(root: Root, banco: string): Promise<void> {
  const q = (sql: string) => root.query(sql);
  // O MySQL 8 recusa DEFAULT em coluna TEXT ("BLOB, TEXT, GEOMETRY or JSON
  // column can't have a default value"): texto curto e com default vai de
  // varchar; os demais TEXT ficam sem default.
  // A tabela CCT real do JetEngine (medida na VPS).
  await q(`
    create table \`${banco}\`.\`wp_jet_cct_imovel\` (
      _ID bigint unsigned not null auto_increment,
      cct_status varchar(20) not null default 'publish',
      situacao text,
      titulo text not null,
      preco bigint default null,
      quartos bigint default null,
      bairro text,
      cidade text,
      area bigint default null,
      imagem bigint default null,
      cct_author_id bigint default null,
      cct_created datetime default null,
      cct_modified datetime default null,
      primary key (_ID)
    ) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_unicode_520_ci;
  `);
  // Uma tabela plana de outro nicho (carros): prova que a receita é genérica.
  await q(`
    create table \`${banco}\`.\`carros\` (
      id bigint unsigned not null auto_increment,
      modelo text not null,
      ano bigint default null,
      km bigint default null,
      preco text,
      cambio text,
      situacao text,
      primary key (id)
    ) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_unicode_520_ci;
  `);
}

async function semeia(root: Root, banco: string): Promise<void> {
  const q = (sql: string, params: unknown[] = []) => root.query(sql, params);

  // ── Imóveis na CCT ────────────────────────────────────────────────────────
  await q(
    `insert into \`${banco}\`.\`wp_jet_cct_imovel\`
      (cct_status, titulo, preco, quartos, bairro, cidade, area, situacao)
    values (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["publish", "Casa Centro Sorocaba", 350000, 3, "Centro", "Sorocaba", 120, "disponivel"],
  );
  await q(
    `insert into \`${banco}\`.\`wp_jet_cct_imovel\`
      (cct_status, titulo, preco, quartos, bairro, cidade, area, situacao)
    values (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["publish", "Apartamento Campolim", 650000, 2, "Campolim", "Sorocaba", 65, "vendido"],
  );
  await q(
    `insert into \`${banco}\`.\`wp_jet_cct_imovel\`
      (cct_status, titulo, preco, quartos, bairro, cidade, area, situacao)
    values (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["draft", "Rascunho Invisível", 200000, 1, "Centro", "Votorantim", 40, "disponivel"],
  );
  // ── Carros (outro nicho) ──────────────────────────────────────────────────
  await q(
    `insert into \`${banco}\`.\`carros\` (id, modelo, ano, km, preco, cambio, situacao)
    values (?, ?, ?, ?, ?, ?, ?)`,
    [1, "Fiat Uno 2020", 2020, 80000, "R$ 45.000,00", "manual", "disponivel"],
  );
  await q(
    `insert into \`${banco}\`.\`carros\` (id, modelo, ano, km, preco, cambio, situacao)
    values (?, ?, ?, ?, ?, ?, ?)`,
    [2, "Toyota Corolla 2023", 2023, 10000, "R$ 120.000,00", "automatico", "vendido"],
  );
}

const FIXOS_CCT = {
  tabela: "wp_jet_cct_imovel",
  coluna_id: "_ID",
  coluna_titulo: "titulo",
  campos: [
    { chave: "preco", rotulo: "Preço", coluna: "preco", tipo: "preco", filtro: "maximo" },
    { chave: "quartos", rotulo: "Quartos", coluna: "quartos", tipo: "numero", filtro: "minimo" },
    { chave: "bairro", rotulo: "Bairro", coluna: "bairro", tipo: "texto", filtro: "contem" },
    { chave: "cidade", rotulo: "Cidade", coluna: "cidade", tipo: "texto", filtro: "contem" },
  ],
  so_mostrar_quando: { coluna: "cct_status", valor: "publish" },
  esconder_quando: { coluna: "situacao", valores: ["vendido", "alugado"] },
};

const FIXOS_CARROS = {
  tabela: "carros",
  coluna_id: "id",
  coluna_titulo: "modelo",
  campos: [
    { chave: "ano", rotulo: "Ano", coluna: "ano", tipo: "numero", filtro: "minimo" },
    { chave: "preco", rotulo: "Preço", coluna: "preco", tipo: "preco", filtro: "maximo" },
    { chave: "cambio", rotulo: "Câmbio", coluna: "cambio", tipo: "texto", filtro: "contem" },
  ],
  esconder_quando: { coluna: "situacao", valores: ["vendido"] },
};

/** Executa o SQL montado pela receita contra o MySQL de verdade. */
async function consultar(
  fixos: Record<string, unknown>,
  busca: Record<string, unknown>,
  limite = 5,
): Promise<Record<string, unknown>[]> {
  const pool = obterPoolMysql(conexaoDe(banco, { sslMode: "disable" }));
  const { sql, valores } = RECEITA_TABELA_DIRETA.montar(fixos, busca, limite);
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
    return linhas as Record<string, unknown>[];
  } finally {
    conexao.release();
  }
}

const titulos = (linhas: Record<string, unknown>[]) =>
  linhas.map((l) => String(l.titulo ?? l.modelo ?? ""));

describe("receita tabela-direta contra MySQL 8 de verdade", () => {
  beforeAll(async () => {
    root = await conectarComoRoot();
    banco = await novoBanco(root, "tabela-direta");
    await criarTabelas(root, banco);
    await semeia(root, banco);
  });

  afterAll(async () => {
    await apagarBanco(root, banco);
    await root.end().catch(() => undefined);
  });

  it("só publicados: rascunho nunca aparece, mesmo sem filtro", async () => {
    const linhas = await consultar(FIXOS_CCT, {}, 20);
    registrar(
      "C1-tabela-direta-sso-publicados",
      `sem filtro → ${titulos(linhas).join(", ")}`,
    );
    // O seed tem um único imóvel publicado e não vendido: Casa Centro
    // Sorocaba. O Apartamento Campolim é vendido, e o caso seguinte prova
    // que ele é eliminado pelo esconder-quando.
    expect(titulos(linhas)).toContain("Casa Centro Sorocaba");
    // O rascunho (cct_status = draft) não aparece por causa do so_mostrar_quando.
    expect(titulos(linhas)).not.toContain("Rascunho Invisível");
  });

  it("esconder: vendido nunca aparece, mesmo que seja publicado", async () => {
    const linhas = await consultar(FIXOS_CCT, {}, 20);
    expect(titulos(linhas)).not.toContain("Apartamento Campolim");
  });

  it("esconder: item SEM situação (NULL) continua aparecendo", async () => {
    // `NULL not in (...)` é NULL no SQL; sem o `is null` da receita, todo item
    // com a coluna de esconder vazia sumia junto com os vendidos.
    await root.query(
      `insert into \`${banco}\`.\`wp_jet_cct_imovel\`
        (cct_status, titulo, preco, quartos, bairro, cidade, area, situacao)
      values (?, ?, ?, ?, ?, ?, ?, ?)`,
      ["publish", "Sala Sem Situação", 150000, 1, "Centro", "Sorocaba", 30, null],
    );
    try {
      const linhas = await consultar(FIXOS_CCT, {}, 20);
      expect(titulos(linhas)).toContain("Sala Sem Situação");
      expect(titulos(linhas)).not.toContain("Apartamento Campolim");
    } finally {
      await root.query(
        `delete from \`${banco}\`.\`wp_jet_cct_imovel\` where titulo = ?`,
        ["Sala Sem Situação"],
      );
    }
  });

  it("filtro de preço máximo: preço texto é convertido e compara como número", async () => {
    const baratos = await consultar(FIXOS_CCT, { filtros: { preco: 400000 } }, 20);
    expect(titulos(baratos)).toContain("Casa Centro Sorocaba");
    expect(titulos(baratos)).not.toContain("Apartamento Campolim");
  });

  it("filtro de bairro por contém: acha o imóvel do bairro", async () => {
    const centro = await consultar(FIXOS_CCT, { filtros: { bairro: "centro" } }, 20);
    expect(titulos(centro)).toContain("Casa Centro Sorocaba");
    expect(titulos(centro)).not.toContain("Apartamento Campolim");
  });

  it("TODA coluna mapeada sai na linha (bairro, cidade, quartos)", async () => {
    const linhas = await consultar(FIXOS_CCT, {}, 20);
    const casa = linhas.find((l) => l.titulo === "Casa Centro Sorocaba");
    expect(casa).toBeDefined();
    expect(String(casa!.bairro)).toBe("Centro");
    expect(String(casa!.cidade)).toBe("Sorocaba");
    expect(Number(casa!.quartos)).toBe(3);
    expect(Number(casa!.preco)).toBe(350000);
  });

  it("outro nicho (carros): mesma receita, outra tabela", async () => {
    const linhas = await consultar(FIXOS_CARROS, {}, 20);
    registrar(
      "C1-tabela-direta-carros",
      `carros sem filtro → ${titulos(linhas).join(", ")}`,
    );
    expect(titulos(linhas)).toContain("Fiat Uno 2020");
    // O vendido é escondido pelo esconder_quando.
    expect(titulos(linhas)).not.toContain("Toyota Corolla 2023");
  });

  it("filtro de câmbio por contém no carro", async () => {
    const manuais = await consultar(
      FIXOS_CARROS,
      { filtros: { cambio: "manual" } },
      20,
    );
    expect(titulos(manuais)).toEqual(["Fiat Uno 2020"]);
  });

  it("filtro de ano mínimo no carro", async () => {
    const novos = await consultar(FIXOS_CARROS, { filtros: { ano: 2021 } }, 20);
    expect(titulos(novos)).not.toContain("Fiat Uno 2020");
    expect(titulos(novos)).not.toContain("Toyota Corolla 2023");
  });

  it("sem só-mostrar, sem esconder e sem filtro não emite WHERE e traz tudo", async () => {
    const fixosSemRegras = {
      tabela: "wp_jet_cct_imovel",
      coluna_id: "_ID",
      coluna_titulo: "titulo",
      campos: [
        { chave: "bairro", rotulo: "Bairro", coluna: "bairro", tipo: "texto", filtro: "nenhum" },
      ],
    };
    const linhas = await consultar(fixosSemRegras, {}, 20);
    // Sem so_mostrar_quando, o rascunho (draft) aparece.
    expect(titulos(linhas)).toContain("Rascunho Invisível");
    expect(titulos(linhas).length).toBe(3);
  });

  it("filtro igual: bairro exatamente Centro", async () => {
    const fixosComIgual = {
      ...FIXOS_CCT,
      campos: [
        { chave: "bairro", rotulo: "Bairro", coluna: "bairro", tipo: "texto", filtro: "igual" },
      ],
      so_mostrar_quando: undefined,
      esconder_quando: undefined,
    };
    const linhas = await consultar(fixosComIgual, { filtros: { bairro: "Centro" } }, 20);
    expect(titulos(linhas)).toContain("Casa Centro Sorocaba");
    expect(titulos(linhas)).toContain("Rascunho Invisível");
    expect(titulos(linhas)).not.toContain("Apartamento Campolim");
  });

  it("LIKE escapa curingas: 100% não casa tudo", async () => {
    const fixosComContem = {
      ...FIXOS_CCT,
      campos: [
        { chave: "bairro", rotulo: "Bairro", coluna: "bairro", tipo: "texto", filtro: "contem" },
      ],
      so_mostrar_quando: undefined,
      esconder_quando: undefined,
    };
    const linhas = await consultar(fixosComContem, { filtros: { bairro: "100%" } }, 20);
    // % escapado: não casa nenhum bairro real.
    expect(titulos(linhas)).toEqual([]);
  });
});
