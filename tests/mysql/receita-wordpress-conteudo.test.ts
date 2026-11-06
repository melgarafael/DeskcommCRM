/**
 * Spec 25, item 8 — integração da receita `wordpress-conteudo` contra um MySQL
 * 8 de verdade (job `mysql-integracao`, NÃO roda aqui).
 *
 * O seed tem DOIS nichos, porque a receita é GENÉRICA (decisão do dono do
 * produto, 21/10/2026):
 *
 *  - uma IMOBILIÁRIA pequena, no formato REAL de um site WordPress: bairro e
 *    cidade são CATEGORIAS (taxonomia hierárquica `localizacao`: Sorocaba ›
 *    Centro, Campolim, Jardim; Votorantim › Centro) — não campos; `tipo_imovel`
 *    (Casa, Apartamento) e `finalidade` (Venda, Aluguel) também são categorias
 *    — mais um termo "Venda e Aluguel", o que um site usa para o imóvel que
 *    serve para os dois; o preço, o aluguel, os quartos e a situação são
 *    CAMPOS (meta_key); há imóvel só de ALUGUEL (sem preço de venda) e imóvel
 *    VENDIDO; e os imóveis existem nos DOIS formatos: ACF (meta + par
 *    `_campo`) e JetEngine no modo padrão (meta simples, outro `post_type`);
 *
 *  - uma LOJA DE VEÍCULOS, no MESMO site, com outro `post_type`: 4 carros, um
 *    vendido, um rascunho, e a MARCA como categoria.
 *
 * Cada caso obrigatório prova uma das quatro causas de a receita devolver
 * ZERO imóveis num cadastro realista:
 *  1. bairro só em categoria;
 *  2. preço é obrigatório na receita antiga — imóvel só de aluguel sumia;
 *  3. a situação não era filtrada — imóvel vendido era oferecido;
 *  4. tipo e finalidade não eram lidos.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { criarDialetoDeLeitura, FonteNaoLiberadaError } from "@/lib/external-db/dialeto";
import { obterPoolMysql } from "@/lib/external-db/dialetos/mysql/conexao";
import { RECEITA_WORDPRESS_CONTEUDO } from "@/lib/external-db/receitas/wordpress-conteudo";
import { validarConsultaDeReceita } from "@/lib/external-db/receitas/validador";

import { apagarBanco, conectarComoRoot, conexaoDe, novoBanco, registrar } from "./ajudante";
import type { Root } from "./ajudante";

let root: Root;
let banco: string;

const WP_PREFIXO = "wp_";

/** root.query pode devolver RowDataPacket[] (SELECT) ou [RowDataPacket[], ResultSetHeader] (tupla). Normaliza. */
function extrairLinhas<T = unknown>(resultado: unknown): T[] {
  const arr = Array.isArray(resultado) ? (resultado as unknown[]) : [resultado];
  const primeiro = arr[0];
  return Array.isArray(primeiro) ? (primeiro as T[]) : (arr as T[]);
}

async function criarTabelasWP(root: Root, banco: string): Promise<void> {
  const q = (sql: string) => root.query(sql);
  // O collation é o do WordPress real (utf8mb4_unicode_520_ci) em TODAS as
  // tabelas: um collation diferente entre elas faria o MySQL recusar a
  // comparação de string.
  await q(`
    create table \`${banco}\`.\`${WP_PREFIXO}posts\` (
      ID bigint unsigned not null auto_increment,
      post_title varchar(200) not null default '',
      post_type varchar(20) not null default 'post',
      post_status varchar(20) not null default 'publish',
      guid varchar(255) not null default '',
      primary key (ID)
    ) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_unicode_520_ci;
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
    ) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_unicode_520_ci;
  `);
  // As três tabelas de CATEGORIA, com o DDL real do WordPress 6.x.
  await q(`
    CREATE TABLE \`${banco}\`.\`${WP_PREFIXO}terms\` (\`term_id\` bigint unsigned NOT NULL AUTO_INCREMENT, \`name\` varchar(200) NOT NULL DEFAULT '',
      \`slug\` varchar(200) NOT NULL DEFAULT '', \`term_group\` bigint NOT NULL DEFAULT '0', PRIMARY KEY (\`term_id\`),
      KEY \`slug\` (\`slug\`(191)), KEY \`name\` (\`name\`(191))) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci;
  `);
  await q(`
    CREATE TABLE \`${banco}\`.\`${WP_PREFIXO}term_taxonomy\` (\`term_taxonomy_id\` bigint unsigned NOT NULL AUTO_INCREMENT, \`term_id\` bigint unsigned NOT NULL DEFAULT '0',
      \`taxonomy\` varchar(32) NOT NULL DEFAULT '', \`description\` longtext NOT NULL, \`parent\` bigint unsigned NOT NULL DEFAULT '0',
      \`count\` bigint NOT NULL DEFAULT '0', PRIMARY KEY (\`term_taxonomy_id\`), UNIQUE KEY \`term_id_taxonomy\` (\`term_id\`,\`taxonomy\`),
      KEY \`taxonomy\` (\`taxonomy\`)) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci;
  `);
  await q(`
    CREATE TABLE \`${banco}\`.\`${WP_PREFIXO}term_relationships\` (\`object_id\` bigint unsigned NOT NULL DEFAULT '0', \`term_taxonomy_id\` bigint unsigned NOT NULL DEFAULT '0',
      \`term_order\` int NOT NULL DEFAULT '0', PRIMARY KEY (\`object_id\`,\`term_taxonomy_id\`), KEY \`term_taxonomy_id\` (\`term_taxonomy_id\`))
      DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci;
  `);
}

/** Os termos dos DOIS nichos: a imobiliária e a loja de veículos. */
const TERMOS: { nome: string; slug: string; taxonomia: string; pai?: string }[] = [
  { nome: "Sorocaba", slug: "sorocaba", taxonomia: "localizacao" },
  { nome: "Centro", slug: "sorocaba-centro", taxonomia: "localizacao", pai: "sorocaba" },
  { nome: "Campolim", slug: "sorocaba-campolim", taxonomia: "localizacao", pai: "sorocaba" },
  { nome: "Jardim", slug: "sorocaba-jardim", taxonomia: "localizacao", pai: "sorocaba" },
  { nome: "Votorantim", slug: "votorantim", taxonomia: "localizacao" },
  { nome: "Centro", slug: "votorantim-centro", taxonomia: "localizacao", pai: "votorantim" },
  { nome: "Casa", slug: "casa", taxonomia: "tipo_imovel" },
  { nome: "Apartamento", slug: "apartamento", taxonomia: "tipo_imovel" },
  { nome: "Venda", slug: "venda", taxonomia: "finalidade" },
  { nome: "Aluguel", slug: "aluguel", taxonomia: "finalidade" },
  // O termo que serve para os DOIS: com o filtro por pedaço de texto, ele
  // casava com "venda" e com "aluguel" ao mesmo tempo.
  { nome: "Venda e Aluguel", slug: "venda-e-aluguel", taxonomia: "finalidade" },
  // A loja de veículos: a MARCA é categoria, e o combustível também.
  { nome: "Fiat", slug: "fiat", taxonomia: "marca_veiculo" },
  { nome: "Toyota", slug: "toyota", taxonomia: "marca_veiculo" },
  { nome: "Chevrolet", slug: "chevrolet", taxonomia: "marca_veiculo" },
  { nome: "Flex", slug: "flex", taxonomia: "combustivel" },
  { nome: "Gasolina", slug: "gasolina", taxonomia: "combustivel" },
];

/**
 * Os imóveis. `metas` é o que o site grava; `termos` são os slugs das
 * categorias; `acf` = escreve o par `_campo` (formato ACF) em vez da linha
 * simples (formato JetEngine no modo padrão).
 */
const IMOVEIS: {
  titulo: string;
  postType?: string;
  status?: string;
  acf: boolean;
  metas: Record<string, string>;
  termos: string[];
}[] = [
  {
    titulo: "Casa Centro Sorocaba",
    acf: true,
    metas: {
      codigo: "IM-001",
      preco: "350000",
      quartos: "3",
      banheiros: "2",
      vagas: "2",
      area: "120",
      condominio: "450",
      status_imovel: "disponivel",
    },
    termos: ["sorocaba-centro", "sorocaba", "casa", "venda"],
  },
  {
    titulo: "Apartamento Centro Votorantim",
    acf: true,
    metas: { codigo: "IM-002", preco: "480000", quartos: "2", area: "65", status_imovel: "disponivel" },
    termos: ["votorantim-centro", "votorantim", "apartamento", "venda"],
  },
  {
    titulo: "Casa Campolim",
    acf: true,
    metas: {
      codigo: "IM-003",
      preco: "650.000,00",
      quartos: "4",
      suites: "1",
      area: "200",
      status_imovel: "disponivel",
    },
    termos: ["sorocaba-campolim", "sorocaba", "casa", "venda"],
  },
  {
    // IMÓVEL SÓ DE ALUGUEL: não tem preço de venda. A receita antiga exigia
    // preço por JOIN interno e este imóvel sumia da lista inteira.
    titulo: "Sala Comercial para Aluguel",
    acf: true,
    metas: { codigo: "IM-004", aluguel: "3.500,00", quartos: "1", area: "40", status_imovel: "disponivel" },
    termos: ["sorocaba-centro", "sorocaba", "apartamento", "aluguel"],
  },
  {
    // IMÓVEL VENDIDO: a situação esconde — a receita antiga ofereceria este.
    titulo: "Cobertura Vendida",
    acf: true,
    metas: { codigo: "IM-005", preco: "900000", quartos: "4", area: "300", status_imovel: "vendido" },
    termos: ["sorocaba-centro", "sorocaba", "casa", "venda"],
  },
  {
    // DOIS termos na MESMA taxonomia (bairro): tem que sair UMA vez.
    titulo: "Casa Dois Bairros",
    acf: true,
    metas: { codigo: "IM-006", preco: "420000", quartos: "3", area: "140", status_imovel: "disponivel" },
    termos: ["sorocaba-centro", "sorocaba-campolim", "sorocaba", "casa", "venda"],
  },
  {
    titulo: "Apartamento Preço Americano",
    acf: true,
    metas: { codigo: "IM-007", preco: "650,000.00", quartos: "2", area: "70", status_imovel: "disponivel" },
    termos: ["sorocaba-jardim", "sorocaba", "apartamento", "venda"],
  },
  {
    titulo: "Apartamento Símbolo",
    acf: true,
    metas: { codigo: "IM-008", preco: "R$ 780.000,00", quartos: "2", area: "60", status_imovel: "disponivel" },
    termos: ["sorocaba-jardim", "sorocaba", "apartamento", "venda"],
  },
  {
    titulo: "Casa Preço Sob Consulta",
    acf: true,
    metas: { codigo: "IM-009", preco: "Consulte", quartos: "2", area: "80", status_imovel: "disponivel" },
    termos: ["sorocaba-jardim", "sorocaba", "casa", "venda"],
  },
  {
    titulo: "Apartamento Milhar",
    acf: true,
    metas: { codigo: "IM-010", preco: "1.200.000", quartos: "3", area: "90", status_imovel: "disponivel" },
    termos: ["sorocaba-jardim", "sorocaba", "apartamento", "venda"],
  },
  {
    titulo: "Apartamento Decimal",
    acf: true,
    metas: { codigo: "IM-011", preco: "650000.50", quartos: "2", area: "75", status_imovel: "disponivel" },
    termos: ["sorocaba-jardim", "sorocaba", "apartamento", "venda"],
  },
  {
    titulo: "Rascunho Invisível",
    status: "draft",
    acf: true,
    metas: { codigo: "IM-012", preco: "350000", quartos: "2", status_imovel: "disponivel" },
    termos: ["sorocaba-centro", "sorocaba", "casa", "venda"],
  },
  {
    titulo: "Artigo do Blog",
    postType: "post",
    acf: true,
    metas: { codigo: "IM-013", preco: "1000", quartos: "1", status_imovel: "disponivel" },
    termos: ["sorocaba-centro", "sorocaba", "casa", "venda"],
  },
  {
    // O MESMO cadastro no JetEngine no modo padrão: linhas simples em
    // `wp_postmeta` (sem o par `_campo`) e outro tipo de post.
    titulo: "Casa Jet Centro",
    postType: "imovel_jet",
    acf: false,
    metas: { codigo: "IM-JET-001", preco: "300000", quartos: "2", area: "90", status_imovel: "disponivel" },
    termos: ["sorocaba-centro", "sorocaba", "casa", "venda"],
  },
  {
    // O imóvel com o termo "Venda e Aluguel" (e só ele): a finalidade "venda"
    // e a finalidade "aluguel" NÃO podem trazê-lo — o termo não é nenhum dos
    // dois. Com o filtro por pedaço de texto, ele vinha nos dois.
    titulo: "Loja Mista",
    acf: true,
    metas: { codigo: "IM-014", preco: "380000", quartos: "1", area: "55", status_imovel: "disponivel" },
    termos: ["sorocaba-centro", "sorocaba", "apartamento", "venda-e-aluguel"],
  },
  {
    // O mesmo, MAIS o termo "Aluguel": aqui a finalidade "aluguel" traz.
    titulo: "Galpão Mista com Aluguel",
    acf: true,
    metas: { codigo: "IM-015", aluguel: "4.500,00", quartos: "1", area: "120", status_imovel: "disponivel" },
    termos: ["sorocaba-centro", "sorocaba", "apartamento", "venda-e-aluguel", "aluguel"],
  },
];

/**
 * Os VEÍCULOS — o mesmo site, outro tipo de post.
 *
 * O Toyota é de 2023 e roda 10.000 km: ele passaria em QUALQUER filtro de ano
 * ou de quilometragem, e só não aparece porque está VENDIDO. O Chevrolet é
 * novo e não aparece porque é rascunho.
 */
const VEICULOS: {
  titulo: string;
  status?: string;
  metas: Record<string, string>;
  termos: string[];
}[] = [
  {
    titulo: "Fiat Uno 2020",
    metas: { ano: "2020", km: "80000", preco: "45000", cambio: "manual", status_veiculo: "disponivel" },
    termos: ["fiat", "flex"],
  },
  {
    titulo: "Fiat Palio 2021",
    metas: { ano: "2021", km: "30000", preco: "55000", cambio: "manual", status_veiculo: "disponivel" },
    termos: ["fiat", "gasolina"],
  },
  {
    titulo: "Toyota Corolla 2023 Vendido",
    metas: { ano: "2023", km: "10000", preco: "120000", cambio: "automatico", status_veiculo: "vendido" },
    termos: ["toyota", "flex"],
  },
  {
    titulo: "Chevrolet Onix 2022 Rascunho",
    status: "draft",
    metas: { ano: "2022", km: "5000", preco: "90000", cambio: "manual", status_veiculo: "disponivel" },
    termos: ["chevrolet", "flex"],
  },
];

/** Os fixos da IMOBILIÁRIA: campos + categorias + a situação que esconde o vendido. */
const FIXOS_IMOVEIS = {
  prefixo: WP_PREFIXO,
  post_type: "imovel",
  campos: [
    { chave: "codigo", rotulo: "Código", meta_key: "codigo", tipo: "texto", filtro: "nenhum" },
    { chave: "preco", rotulo: "Preço de venda", meta_key: "preco", tipo: "preco", filtro: "maximo" },
    { chave: "aluguel", rotulo: "Aluguel", meta_key: "aluguel", tipo: "preco", filtro: "maximo" },
    { chave: "condominio", rotulo: "Condomínio", meta_key: "condominio", tipo: "preco", filtro: "nenhum" },
    { chave: "quartos", rotulo: "Quartos", meta_key: "quartos", tipo: "numero", filtro: "minimo" },
    { chave: "suites", rotulo: "Suítes", meta_key: "suites", tipo: "numero", filtro: "minimo" },
    { chave: "banheiros", rotulo: "Banheiros", meta_key: "banheiros", tipo: "numero", filtro: "nenhum" },
    { chave: "vagas", rotulo: "Vagas", meta_key: "vagas", tipo: "numero", filtro: "minimo" },
    { chave: "area", rotulo: "Área", meta_key: "area", tipo: "numero", filtro: "minimo" },
  ],
  categorias: [
    { chave: "bairro", rotulo: "Bairro", taxonomia: "localizacao", nivel: "filho", filtro: "contem" },
    { chave: "cidade", rotulo: "Cidade", taxonomia: "localizacao", nivel: "raiz", filtro: "contem" },
    { chave: "tipo", rotulo: "Tipo", taxonomia: "tipo_imovel", nivel: "qualquer", filtro: "contem" },
    { chave: "finalidade", rotulo: "Finalidade", taxonomia: "finalidade", nivel: "qualquer", filtro: "igual" },
  ],
  esconder: { meta_key: "status_imovel", valores: ["vendido", "alugado"] },
};

/** Os fixos da LOJA DE VEÍCULOS: o MESMO código, outra configuração. */
const FIXOS_VEICULOS = {
  prefixo: WP_PREFIXO,
  post_type: "veiculo",
  campos: [
    { chave: "ano", rotulo: "Ano", meta_key: "ano", tipo: "numero", filtro: "minimo" },
    { chave: "km", rotulo: "Quilometragem", meta_key: "km", tipo: "numero", filtro: "maximo" },
    { chave: "preco", rotulo: "Preço", meta_key: "preco", tipo: "preco", filtro: "maximo" },
    { chave: "cambio", rotulo: "Câmbio", meta_key: "cambio", tipo: "texto", filtro: "contem" },
  ],
  categorias: [
    { chave: "marca", rotulo: "Marca", taxonomia: "marca_veiculo", nivel: "qualquer", filtro: "contem" },
    { chave: "combustivel", rotulo: "Combustível", taxonomia: "combustivel", nivel: "qualquer", filtro: "igual" },
  ],
  esconder: { meta_key: "status_veiculo", valores: ["vendido", "alugado"] },
};

async function semeia(root: Root, banco: string): Promise<void> {
  const q = (sql: string, params: unknown[] = []) => root.query(sql, params);

  // ── 1. As categorias ──────────────────────────────────────────────────────
  const termIdPorSlug = new Map<string, number>();
  for (const termo of TERMOS) {
    await q(
      `insert into \`${banco}\`.\`${WP_PREFIXO}terms\` (name, slug) values (?, ?)`,
      [termo.nome, termo.slug],
    );
    const id = Number(
      (extrairLinhas<{ id: number }>(await q(`select LAST_INSERT_ID() as id`))[0] as { id: number })
        ?.id ?? 0,
    );
    termIdPorSlug.set(termo.slug, id);
  }

  const ttIdPorSlug = new Map<string, number>();
  for (const termo of TERMOS) {
    const termId = termIdPorSlug.get(termo.slug)!;
    const pai = termo.pai ? termIdPorSlug.get(termo.pai)! : 0;
    await q(
      `insert into \`${banco}\`.\`${WP_PREFIXO}term_taxonomy\` (term_id, taxonomy, description, parent, count) values (?, ?, '', ?, 0)`,
      [termId, termo.taxonomia, pai],
    );
    const id = Number(
      (extrairLinhas<{ id: number }>(await q(`select LAST_INSERT_ID() as id`))[0] as { id: number })
        ?.id ?? 0,
    );
    ttIdPorSlug.set(termo.slug, id);
  }

  // ── 2. Os posts (imóveis e veículos) ───────────────────────────────────────
  const semeiaPost = async (
    post: { titulo: string; postType?: string; status?: string; acf?: boolean; metas: Record<string, string>; termos: string[] },
    postTypePadrao: string,
  ): Promise<void> => {
    const postType = post.postType ?? postTypePadrao;
    const status = post.status ?? "publish";
    await q(
      `insert into \`${banco}\`.\`${WP_PREFIXO}posts\` (post_title, post_type, post_status, guid) values (?, ?, ?, ?)`,
      [post.titulo, postType, status, `http://exemplo/?p=${post.titulo}`],
    );
    const postId = Number(
      (extrairLinhas<{ id: number }>(await q(`select LAST_INSERT_ID() as id`))[0] as { id: number })
        ?.id ?? 0,
    );

    for (const [chave, valor] of Object.entries(post.metas)) {
      await q(
        `insert into \`${banco}\`.\`${WP_PREFIXO}postmeta\` (post_id, meta_key, meta_value) values (?, ?, ?)`,
        [postId, chave, valor],
      );
      // O ACF grava o par: o campo e o `_campo` (o nome do campo no grupo).
      if (post.acf) {
        await q(
          `insert into \`${banco}\`.\`${WP_PREFIXO}postmeta\` (post_id, meta_key, meta_value) values (?, ?, ?)`,
          [postId, `_${chave}`, `${chave}_${postId}`],
        );
      }
    }

    for (const slug of post.termos) {
      await q(
        `insert into \`${banco}\`.\`${WP_PREFIXO}term_relationships\` (object_id, term_taxonomy_id) values (?, ?)`,
        [postId, ttIdPorSlug.get(slug)!],
      );
    }
  };

  for (const imovel of IMOVEIS) await semeiaPost(imovel, "imovel");
  for (const veiculo of VEICULOS) await semeiaPost(veiculo, "veiculo");
}

describe("receita wordpress-conteudo contra MySQL 8 de verdade", () => {
  beforeAll(async () => {
    root = await conectarComoRoot();
    banco = await novoBanco(root, "wordpress-conteudo");
    await criarTabelasWP(root, banco);
    await semeia(root, banco);
  });

  afterAll(async () => {
    await apagarBanco(root, banco);
    await root.end().catch(() => undefined);
  });

  /** Executa o SQL montado pela receita contra o MySQL de verdade. */
  async function consultar(
    busca: Record<string, unknown>,
    limite = 5,
    fixos: unknown = FIXOS_IMOVEIS,
  ): Promise<Record<string, unknown>[]> {
    const pool = obterPoolMysql(conexaoDe(banco, { sslMode: "disable" }));
    const { sql, valores } = RECEITA_WORDPRESS_CONTEUDO.montar(fixos, busca, limite);
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
    linhas.map((l) => String(l.titulo ?? ""));

  it("mede o DDL e as tabelas criadas", async () => {
    const tabelas = extrairLinhas<{ table_name: string }>(
      await root.query(
        `select table_name as table_name from information_schema.tables where table_schema = ?`,
        [banco],
      ),
    );
    registrar("C1-wordpress-conteudo", `tabelas: ${tabelas.map((t) => t.table_name).join(", ")}`);
    expect(tabelas.map((t) => t.table_name).sort()).toEqual(
      [
        `${WP_PREFIXO}posts`,
        `${WP_PREFIXO}postmeta`,
        `${WP_PREFIXO}terms`,
        `${WP_PREFIXO}term_taxonomy`,
        `${WP_PREFIXO}term_relationships`,
      ].sort(),
    );
  });

  it("monta SQL e passa no validador com as tabelas permitidas", () => {
    const { sql, valores } = RECEITA_WORDPRESS_CONTEUDO.montar(FIXOS_IMOVEIS, {}, 5);
    const tabelas = RECEITA_WORDPRESS_CONTEUDO.tabelas(FIXOS_IMOVEIS);
    expect(() => validarConsultaDeReceita(sql, tabelas)).not.toThrow();
    expect(valores).toContain("imovel");
    expect(valores).toContain("publish");
    expect(valores).toContain("localizacao");
    expect(sql.split("?").length - 1).toBe(valores.length);
  });

  it("a chave que é PALAVRA RESERVADA do MySQL sai na consulta (o 'key' de verdade)", async () => {
    // `key` é palavra reservada do MySQL: como apelido cru, a consulta nem
    // roda (erro de sintaxe). O apelido da saída vai quotado — e o dado
    // chamado "key" volta na linha, com o nome "key".
    const fixosComKey = {
      ...FIXOS_IMOVEIS,
      campos: [
        { chave: "key", rotulo: "Chave do anúncio", meta_key: "codigo", tipo: "texto", filtro: "contem" },
      ],
      categorias: [],
    };
    const linhas = await consultar({ filtros: { key: "IM-001" } }, 5, fixosComKey);
    registrar(
      "C1-wordpress-conteudo-chave-reservada",
      `chave 'key' → ${titulos(linhas).join(", ")}`,
    );
    expect(titulos(linhas)).toEqual(["Casa Centro Sorocaba"]);
    // E a COLUNA saiu com o nome que a pessoa pediu.
    expect(String(linhas[0]?.key)).toBe("IM-001");
  });

  it("CAUSA 1 — bairro só em categoria: a busca acha o imóvel do bairro", async () => {
    const linhas = await consultar({ filtros: { bairro: "campolim" } });
    registrar(
      "C1-wordpress-conteudo-bairro-categoria",
      `bairro 'campolim' → ${titulos(linhas).join(", ")}`,
    );
    expect(titulos(linhas)).toContain("Casa Campolim");
    expect(titulos(linhas)).not.toContain("Casa Centro Sorocaba");
  });

  it("CAUSA 2 — imóvel só de aluguel aparece no aluguel e some no preço máximo", async () => {
    const noAluguel = await consultar({ filtros: { finalidade: "aluguel" } });
    registrar(
      "C1-wordpress-conteudo-finalidade-aluguel",
      `finalidade 'aluguel' → ${titulos(noAluguel).join(", ")}`,
    );
    expect(titulos(noAluguel)).toContain("Sala Comercial para Aluguel");
    // O mesmo imóvel, com teto de PREÇO: sem preço de venda, ele não entra.
    const noPreco = await consultar({ filtros: { preco: 600000 } });
    expect(titulos(noPreco)).not.toContain("Sala Comercial para Aluguel");
    // E o filtro de ALUGUEL o traz (o aluguel é 3.500,00).
    const ate3500 = await consultar({ filtros: { aluguel: 3500 } });
    expect(titulos(ate3500)).toContain("Sala Comercial para Aluguel");
    const ate3000 = await consultar({ filtros: { aluguel: 3000 } });
    expect(titulos(ate3000)).not.toContain("Sala Comercial para Aluguel");
  });

  it("CAUSA 3 — imóvel vendido nunca aparece", async () => {
    const linhas = await consultar({});
    registrar("C1-wordpress-conteudo-vendido", `sem filtro → ${titulos(linhas).join(", ")}`);
    expect(titulos(linhas)).not.toContain("Cobertura Vendida");
    // Nem quando o filtro é largo.
    const largos = await consultar({ filtros: { preco: 2000000 } }, 20);
    expect(titulos(largos)).not.toContain("Cobertura Vendida");
  });

  it("CAUSA 4 — tipo e finalidade filtram pela categoria", async () => {
    const casas = await consultar({ filtros: { tipo: "casa" } }, 20);
    registrar("C1-wordpress-conteudo-tipo", `tipo 'casa' → ${titulos(casas).join(", ")}`);
    expect(titulos(casas).length).toBeGreaterThan(0);
    for (const linha of casas) {
      expect(String(linha.tipo)).toContain("Casa");
      expect(String(linha.tipo)).not.toContain("Apartamento");
    }

    const paraVenda = await consultar({ filtros: { finalidade: "venda" } }, 20);
    registrar(
      "C1-wordpress-conteudo-finalidade-venda",
      `finalidade 'venda' → ${titulos(paraVenda).join(", ")}`,
    );
    expect(titulos(paraVenda).length).toBeGreaterThan(0);
    for (const linha of paraVenda) {
      expect(String(linha.finalidade)).toContain("Venda");
    }
    // A finalidade casa pelo SLUG do termo ("venda"), não só pelo nome.
    const porSlug = await consultar({ filtros: { finalidade: "venda" } }, 20);
    expect(titulos(porSlug)).toContain("Casa Centro Sorocaba");
  });

  it("a finalidade casa por IGUALDADE: o termo 'Venda e Aluguel' não é 'aluguel'", async () => {
    const noAluguel = await consultar({ filtros: { finalidade: "aluguel" } }, 20);
    registrar(
      "C1-wordpress-conteudo-finalidade-igualdade",
      `finalidade 'aluguel' → ${titulos(noAluguel).join(", ")}`,
    );
    // O imóvel com o termo "Venda e Aluguel" NÃO entra: o termo não é
    // "aluguel". Com o filtro por PEDÇO do texto, ele entrava nos dois.
    expect(titulos(noAluguel)).not.toContain("Loja Mista");
    // O imóvel que tem o termo "Aluguel" (além do misto) entra.
    expect(titulos(noAluguel)).toContain("Galpão Mista com Aluguel");

    const naVenda = await consultar({ filtros: { finalidade: "venda" } }, 20);
    registrar(
      "C1-wordpress-conteudo-finalidade-igualdade-venda",
      `finalidade 'venda' → ${titulos(naVenda).join(", ")}`,
    );
    // E o "Venda e Aluguel" também não é "venda".
    expect(titulos(naVenda)).not.toContain("Loja Mista");
    expect(titulos(naVenda)).not.toContain("Galpão Mista com Aluguel");
  });

  it("nível: o bairro acha o Centro de Sorocaba e o de Votorantim; a cidade, só o dela", async () => {
    const centros = await consultar({ filtros: { bairro: "centro" } }, 20);
    registrar(
      "C1-wordpress-conteudo-nivel-bairro",
      `bairro 'centro' → ${titulos(centros).join(", ")}`,
    );
    expect(titulos(centros)).toContain("Casa Centro Sorocaba");
    expect(titulos(centros)).toContain("Apartamento Centro Votorantim");

    const votorantim = await consultar({ filtros: { cidade: "votorantim" } }, 20);
    registrar(
      "C1-wordpress-conteudo-nivel-cidade",
      `cidade 'votorantim' → ${titulos(votorantim).join(", ")}`,
    );
    expect(titulos(votorantim)).toEqual(["Apartamento Centro Votorantim"]);
  });

  it("rascunho e outro post_type nunca aparecem", async () => {
    const linhas = await consultar({}, 20);
    expect(titulos(linhas)).not.toContain("Rascunho Invisível");
    expect(titulos(linhas)).not.toContain("Artigo do Blog");
  });

  it("o imóvel com DOIS termos na mesma taxonomia aparece UMA vez", async () => {
    const linhas = await consultar({ filtros: { bairro: "centro" } }, 20);
    const doisBairros = linhas.filter((l) => l.titulo === "Casa Dois Bairros");
    registrar(
      "C1-wordpress-conteudo-dois-termos",
      `Casa Dois Bairros: ${doisBairros.length} linha(s), bairro='${doisBairros[0]?.bairro ?? ""}'`,
    );
    expect(doisBairros).toHaveLength(1);
    // Os dois nomes de bairro estão na MESMA célula (group_concat).
    expect(String(doisBairros[0]?.bairro)).toContain("Centro");
    expect(String(doisBairros[0]?.bairro)).toContain("Campolim");
  });

  it("o JetEngine no modo padrão (meta simples, outro post_type) funciona igual", async () => {
    const fixosJet = { ...FIXOS_IMOVEIS, post_type: "imovel_jet" };
    const linhas = await consultar({ filtros: { bairro: "centro" } }, 20, fixosJet);
    registrar("C1-wordpress-conteudo-jetengine", `JetEngine → ${titulos(linhas).join(", ")}`);
    expect(titulos(linhas)).toEqual(["Casa Jet Centro"]);
    // E a mesma configuração não acha o imóvel do ACF (são tipos de post diferentes).
    const doAcf = await consultar({ filtros: { bairro: "centro" } }, 20);
    expect(titulos(doAcf)).not.toContain("Casa Jet Centro");
  });

  it("os formatos de preço continuam valendo (o reparo anterior)", async () => {
    const brasileiro = await consultar({ filtros: { bairro: "campolim" } });
    const linhaBrasileira = brasileiro.find((l) => l.titulo === "Casa Campolim");
    expect(linhaBrasileira).toBeDefined();
    expect(Number(linhaBrasileira!.preco)).toBe(650000);

    const americano = await consultar({ filtros: { bairro: "jardim", preco: 1000 } });
    expect(titulos(americano)).not.toContain("Apartamento Preço Americano");
    const americano2 = await consultar({ filtros: { bairro: "jardim", preco: 700000 } });
    const linhaAmericana = americano2.find((l) => l.titulo === "Apartamento Preço Americano");
    expect(linhaAmericana).toBeDefined();
    expect(Number(linhaAmericana!.preco)).toBe(650000);

    const simbolo = await consultar({ filtros: { bairro: "jardim", preco: 300000 } });
    expect(titulos(simbolo)).not.toContain("Apartamento Símbolo");
    const simbolo2 = await consultar({ filtros: { bairro: "jardim", preco: 800000 } });
    const linhaSimbolo = simbolo2.find((l) => l.titulo === "Apartamento Símbolo");
    expect(linhaSimbolo).toBeDefined();
    expect(Number(linhaSimbolo!.preco)).toBe(780000);

    const semNumero = await consultar({ filtros: { bairro: "jardim" } });
    const linhaSemNumero = semNumero.find((l) => l.titulo === "Casa Preço Sob Consulta");
    expect(linhaSemNumero).toBeDefined();
    expect(linhaSemNumero!.preco ?? null).toBeNull();

    const milhar = await consultar({ filtros: { bairro: "jardim", preco: 1300000 } });
    const linhaMilhar = milhar.find((l) => l.titulo === "Apartamento Milhar");
    expect(linhaMilhar).toBeDefined();
    expect(Number(linhaMilhar!.preco)).toBe(1200000);

    const decimal = await consultar({ filtros: { bairro: "jardim", preco: 650001 } });
    const linhaDecimal = decimal.find((l) => l.titulo === "Apartamento Decimal");
    expect(linhaDecimal).toBeDefined();
    expect(Number(linhaDecimal!.preco)).toBe(650000.5);
  });

  // ─── O MESMO CÓDIGO, OUTRO NICHO ──────────────────────────────────────────
  describe("a mesma receita, o nicho de veículos", () => {
    const consultarVeiculo = (filtros: Record<string, string | number>, limite = 20) =>
      consultar({ filtros }, limite, FIXOS_VEICULOS);

    it("a marca é categoria: o filtro por marca acha os carros daquela marca", async () => {
      const linhas = await consultarVeiculo({ marca: "fiat" });
      registrar("C1-wordpress-conteudo-veiculo-marca", `marca 'fiat' → ${titulos(linhas).join(", ")}`);
      expect(titulos(linhas).sort()).toEqual(["Fiat Palio 2021", "Fiat Uno 2020"]);
    });

    it("ano mínimo: só o carro que passa no ano entra", async () => {
      const linhas = await consultarVeiculo({ ano: 2020 });
      registrar("C1-wordpress-conteudo-veiculo-ano", `ano >= 2020 → ${titulos(linhas).join(", ")}`);
      // O Toyota de 2023 passaria — e não entra, porque está vendido.
      expect(titulos(linhas).sort()).toEqual(["Fiat Palio 2021", "Fiat Uno 2020"]);
    });

    it("quilometragem máxima: o carro que passa no limite entra", async () => {
      const linhas = await consultarVeiculo({ km: 60000 });
      registrar("C1-wordpress-conteudo-veiculo-km", `km <= 60000 → ${titulos(linhas).join(", ")}`);
      expect(titulos(linhas)).toEqual(["Fiat Palio 2021"]);
      // O Uno rodou 80.000: não entra.
      expect(titulos(linhas)).not.toContain("Fiat Uno 2020");
    });

    it("combustível por igualdade: o termo é 'flex' ou nada", async () => {
      const linhas = await consultarVeiculo({ combustivel: "flex" });
      registrar(
        "C1-wordpress-conteudo-veiculo-combustivel",
        `combustível 'flex' → ${titulos(linhas).join(", ")}`,
      );
      expect(titulos(linhas)).toEqual(["Fiat Uno 2020"]);
      // O Toyota é flex também — e está vendido.
      expect(titulos(linhas)).not.toContain("Toyota Corolla 2023 Vendido");
    });

    it("câmbio por conteúdo: o texto casa pelo pedaço", async () => {
      const linhas = await consultarVeiculo({ cambio: "manual" });
      registrar(
        "C1-wordpress-conteudo-veiculo-cambio",
        `câmbio 'manual' → ${titulos(linhas).join(", ")}`,
      );
      expect(titulos(linhas).sort()).toEqual(["Fiat Palio 2021", "Fiat Uno 2020"]);
    });

    it("o vendido e o rascunho nunca aparecem", async () => {
      const linhas = await consultarVeiculo({});
      expect(titulos(linhas)).not.toContain("Toyota Corolla 2023 Vendido");
      expect(titulos(linhas)).not.toContain("Chevrolet Onix 2022 Rascunho");
      expect(titulos(linhas).sort()).toEqual(["Fiat Palio 2021", "Fiat Uno 2020"]);
    });

    it("a configuração de imóveis não acha veículo (o tipo de post manda)", async () => {
      // Sem filtro que a configuração de imóveis não tem: ela só lê o
      // tipo de post "imovel", então nenhum veículo aparece — mas os
      // imóveis aparecem, e a lista não é vazia.
      const linhas = await consultar({}, 20);
      const titulosVeiculos = VEICULOS.map((v) => v.titulo);
      for (const linha of linhas) {
        expect(titulosVeiculos).not.toContain(String(linha.titulo));
      }
      expect(titulos(linhas)).not.toHaveLength(0);
    });
  });

  it("fonte_nao_liberada quando a categoria está mapeada e a tabela de termos não foi liberada", async () => {
    const regra = {
      modo: "list" as const,
      fontes: [
        { schema: banco, tabela: `${WP_PREFIXO}posts`, colunas: null, descricao: "" },
        { schema: banco, tabela: `${WP_PREFIXO}postmeta`, colunas: null, descricao: "" },
        { schema: banco, tabela: `${WP_PREFIXO}terms`, colunas: null, descricao: "" },
        { schema: banco, tabela: `${WP_PREFIXO}term_taxonomy`, colunas: null, descricao: "" },
        // `term_relationships` DE FORA: é a tabela que amarra o post ao termo.
      ],
    };
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
    const { sql, valores } = RECEITA_WORDPRESS_CONTEUDO.montar(FIXOS_IMOVEIS, {}, 5);
    await expect(
      d.executarReceita(
        {
          sql,
          valores,
          tabelas: RECEITA_WORDPRESS_CONTEUDO.tabelas(FIXOS_IMOVEIS),
          colunasPorTabela: RECEITA_WORDPRESS_CONTEUDO.colunas(FIXOS_IMOVEIS),
        },
        { limiteMax: 5 },
      ),
    ).rejects.toBeInstanceOf(FonteNaoLiberadaError);
  });
});
