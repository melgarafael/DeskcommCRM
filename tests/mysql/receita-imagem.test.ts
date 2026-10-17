/**
 * Spec 25 R4 — `imagem_url` das receitas contra um MySQL 8 de verdade (job
 * `mysql-integracao`; NÃO roda na máquina de desenvolvimento).
 *
 * Semeia o DDL mínimo do WordPress com um anexo (`post_type = 'attachment'`,
 * `guid` = URL do arquivo) e o `_thumbnail_id` que o aponta. Prova:
 *  - woocommerce e acf-imoveis: item COM foto devolve o guid do anexo; item SEM
 *    foto continua aparecendo, com `imagem_url` nulo (LEFT JOIN);
 *  - tabela-direta: a coluna mapeada sai como `imagem_url`;
 *  - jetengine-imoveis: o campo de mídia vale URL direta ou, se só dígitos,
 *    resolve pelo guid do anexo (INFERIDO da documentação do JetEngine).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RECEITA_ACF_IMOVEIS } from "@/lib/external-db/receitas/acf-imoveis";
import { RECEITA_JETENGINE_IMOVEIS } from "@/lib/external-db/receitas/jetengine-imoveis";
import { RECEITA_TABELA_DIRETA } from "@/lib/external-db/receitas/tabela-direta";
import { RECEITA_WOOCOMMERCE_PRODUTOS } from "@/lib/external-db/receitas/woocommerce";

import { apagarBanco, conectarComoRoot, novoBanco, registrar } from "./ajudante";
import type { Root } from "./ajudante";

let root: Root;
let banco: string;

const FOTO = "https://loja.exemplo/wp-content/uploads/2026/10/camisa.jpg";
const FOTO_JET = "https://imob.exemplo/wp-content/uploads/2026/10/casa.webp";

async function inserir(sql: string, params: unknown[] = []): Promise<number> {
  const [r] = (await root.query(sql, params)) as unknown as [{ insertId: number }, unknown];
  return r.insertId;
}

async function executar(sql: string, valores: unknown[]): Promise<Array<Record<string, unknown>>> {
  const [linhas] = await root.execute(sql, valores.map((v) => (v === undefined ? null : v)) as never[]);
  return linhas as Array<Record<string, unknown>>;
}

beforeAll(async () => {
  root = await conectarComoRoot();
  banco = await novoBanco(root, "imagem");
  await root.query(`use \`${banco}\``);
  await root.query(`create table wp_posts (
    ID bigint unsigned not null auto_increment, post_title varchar(200) not null default '',
    post_type varchar(20) not null default 'post', post_status varchar(20) not null default 'publish',
    guid varchar(255) not null default '', primary key (ID)) engine=InnoDB character set utf8mb4`);
  await root.query(`create table wp_postmeta (
    meta_id bigint unsigned not null auto_increment, post_id bigint unsigned not null,
    meta_key varchar(255) default null, meta_value longtext default null, primary key (meta_id)
    ) engine=InnoDB character set utf8mb4`);

  // O anexo da foto (post_type = attachment) e o produto/imóvel que o usa como destacada.
  const anexo = await inserir(
    "insert into wp_posts (post_title, post_type, post_status, guid) values ('camisa.jpg','attachment','inherit',?)",
    [FOTO],
  );
  const comFoto = await inserir(
    "insert into wp_posts (post_title, post_type, guid) values ('Camisa com foto','product','http://l/?p=1')",
  );
  const semFoto = await inserir(
    "insert into wp_posts (post_title, post_type, guid) values ('Camisa sem foto','product','http://l/?p=2')",
  );
  const imovel = await inserir(
    "insert into wp_posts (post_title, post_type, guid) values ('Casa com foto','imovel','http://i/?p=3')",
  );
  const imovelSem = await inserir(
    "insert into wp_posts (post_title, post_type, guid) values ('Casa sem foto','imovel','http://i/?p=4')",
  );
  for (const p of [comFoto, semFoto]) {
    await root.query("insert into wp_postmeta (post_id, meta_key, meta_value) values (?,?,?),(?,?,?)", [
      p, "_price", "49.90", p, "_stock_status", "instock",
    ]);
  }
  await root.query("insert into wp_postmeta (post_id, meta_key, meta_value) values (?,?,?)", [
    comFoto, "_thumbnail_id", String(anexo),
  ]);
  for (const p of [imovel, imovelSem]) {
    await root.query(
      "insert into wp_postmeta (post_id, meta_key, meta_value) values (?,?,?),(?,?,?),(?,?,?)",
      [p, "preco", "400000", p, "quartos", "3", p, "bairro", "Centro"],
    );
  }
  await root.query("insert into wp_postmeta (post_id, meta_key, meta_value) values (?,?,?)", [
    imovel, "_thumbnail_id", String(anexo),
  ]);

  // tabela-direta
  await root.query("create table carros (id int primary key, modelo varchar(60), foto varchar(255))");
  await root.query("insert into carros values (1,'Gol',?),(2,'Uno',null)", ["https://c.exemplo/gol.png"]);

  // jetengine: uma linha com URL direta e uma com ID de anexo
  const anexoJet = await inserir(
    "insert into wp_posts (post_title, post_type, post_status, guid) values ('casa.webp','attachment','inherit',?)",
    [FOTO_JET],
  );
  await root.query(`create table wp_jet_cct_imoveis (
    _ID bigint unsigned not null auto_increment primary key, cct_status varchar(20), titulo varchar(100),
    preco varchar(30), quartos int, bairro varchar(60), foto varchar(255))`);
  await root.query(
    `insert into wp_jet_cct_imoveis (cct_status, titulo, preco, quartos, bairro, foto) values
      ('publish','Url direta','300000',2,'Centro',?),
      ('publish','Id de anexo','310000',2,'Centro',?),
      ('publish','Sem foto','320000',2,'Centro',null),
      ('draft','Rascunho','1',2,'Centro',null)`,
    ["https://j.exemplo/direta.jpg", String(anexoJet)],
  );
});

afterAll(async () => {
  await apagarBanco(root, banco);
  await root.end().catch(() => undefined);
});

describe("imagem_url contra MySQL 8", () => {
  it("woocommerce: com foto devolve o guid do anexo; sem foto aparece com imagem_url nulo", async () => {
    const { sql, valores } = RECEITA_WOOCOMMERCE_PRODUTOS.montar({ prefixo: "wp_" }, { busca: "camisa" }, 5);
    const linhas = await executar(sql, valores);
    registrar("R4-woocommerce", JSON.stringify(linhas.map((l) => [l.titulo, l.imagem_url])));
    const por = Object.fromEntries(linhas.map((l) => [String(l.titulo), l.imagem_url]));
    expect(por["Camisa com foto"]).toBe(FOTO);
    expect(por["Camisa sem foto"]).toBeNull();
    expect(linhas).toHaveLength(2);
  });

  it("acf-imoveis: com foto devolve o guid do anexo; sem foto aparece com imagem_url nulo", async () => {
    const fixos = {
      prefixo: "wp_",
      post_type: "imovel",
      campos: { preco: "preco", quartos: "quartos", bairro: "bairro" },
    };
    const { sql, valores } = RECEITA_ACF_IMOVEIS.montar(fixos, {}, 5);
    const linhas = await executar(sql, valores);
    registrar("R4-acf", JSON.stringify(linhas.map((l) => [l.titulo, l.imagem_url])));
    const por = Object.fromEntries(linhas.map((l) => [String(l.titulo), l.imagem_url]));
    expect(por["Casa com foto"]).toBe(FOTO);
    expect(por["Casa sem foto"]).toBeNull();
  });

  it("tabela-direta: colunas.imagem sai como imagem_url", async () => {
    const fixos = RECEITA_TABELA_DIRETA.parametrosFixos.parse({
      tabela: "carros",
      colunas: { id: "id", titulo: "modelo", imagem: "foto", filtros_texto: [], exibir: [] },
    });
    const { sql, valores } = RECEITA_TABELA_DIRETA.montar(fixos, {}, 5);
    const linhas = await executar(sql, valores);
    const por = Object.fromEntries(linhas.map((l) => [String(l.titulo), l.imagem_url]));
    expect(por["Gol"]).toBe("https://c.exemplo/gol.png");
    expect(por["Uno"]).toBeNull();
  });

  it("jetengine-imoveis: URL direta passa; só dígitos resolve pelo guid do anexo; rascunho fica fora", async () => {
    const fixos = RECEITA_JETENGINE_IMOVEIS.parametrosFixos.parse({
      prefixo: "wp_",
      slug: "imoveis",
      campos: { preco: "preco", quartos: "quartos", bairro: "bairro", titulo: "titulo", imagem: "foto" },
    });
    const { sql, valores } = RECEITA_JETENGINE_IMOVEIS.montar(fixos, {}, 5);
    const linhas = await executar(sql, valores);
    registrar("R4-jetengine", JSON.stringify(linhas.map((l) => [l.titulo, l.imagem_url])));
    const por = Object.fromEntries(linhas.map((l) => [String(l.titulo), l.imagem_url]));
    expect(por["Url direta"]).toBe("https://j.exemplo/direta.jpg");
    expect(por["Id de anexo"]).toBe(FOTO_JET);
    expect(por["Sem foto"]).toBeNull();
    expect(por["Rascunho"]).toBeUndefined();
  });
});
