import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  consultarMysql,
  fecharTodosOsPoolsMysql,
  obterPoolMysql,
  testarConexaoMysql,
} from "@/lib/external-db/dialetos/mysql/conexao";
import { AVISO_ESCRITA, AVISO_LEITURA_AMPLA } from "@/lib/external-db/dialetos/mysql/grants";
import { descreverTabelaMysql, listarTabelasMysql } from "@/lib/external-db/dialetos/mysql/introspeccao";
import { lerTabelaMysql } from "@/lib/external-db/dialetos/mysql/leitura";
import type { PedidoDeLeitura } from "@/lib/external-db/types";

import {
  apagarBanco,
  apagarUsuario,
  conectarComoRoot,
  conexaoDe,
  criarUsuario,
  erroCurto,
  novoBanco,
  registrar,
  type Root,
  type UsuarioDeTeste,
} from "./ajudante";

let root: Root;
let banco: string;
const usuarios: UsuarioDeTeste[] = [];

const PERMITIDAS_PEDIDOS = new Set(["id", "criado", "total", "foto", "nota"]);

function pedido(extra: Partial<PedidoDeLeitura> = {}): PedidoDeLeitura {
  return { schema: banco, tabela: "pedidos", colunas: [], filtros: [], limite: 50, offset: 0, ...extra };
}

beforeAll(async () => {
  root = await conectarComoRoot();
  banco = await novoBanco(root, "dialeto");
  const q = (sql: string) => root.query(sql);
  await q(`create table \`${banco}\`.clientes (id int not null, org int not null, nome varchar(80), primary key (org, id)) engine=InnoDB`);
  await q(
    `create table \`${banco}\`.pedidos (id bigint not null primary key, criado datetime, total decimal(10,2), foto blob, nota varchar(100)) engine=InnoDB`,
  );
  await q(`create view \`${banco}\`.v_pedidos as select id, total from \`${banco}\`.pedidos`);
  await q(
    `insert into \`${banco}\`.pedidos values (9007199254740993, '2026-10-08 10:00:00', 12.50, X'DEAD', 'CB 250 F Twister'), (2, '2026-10-09 11:30:00', 3.10, NULL, 'João Silva')`,
  );
});

afterAll(async () => {
  await fecharTodosOsPoolsMysql();
  for (const u of usuarios) await apagarUsuario(root, u);
  await apagarBanco(root, banco);
  await root.end().catch(() => undefined);
});

describe("introspecção contra um MySQL de verdade", () => {
  it("lista só as tabelas e views do banco da conexão, nunca o catálogo do servidor", async () => {
    const pool = obterPoolMysql(conexaoDe(banco));
    const tabelas = await listarTabelasMysql(pool, banco);
    expect(tabelas.map((t) => t.nome).sort()).toEqual(["clientes", "pedidos", "v_pedidos"]);
    expect(tabelas.every((t) => t.schema === banco)).toBe(true);
    registrar("F1", `catálogo do banco de teste: ${tabelas.map((t) => `${t.nome}(${t.tipo})`).join(", ")}`);
  });

  it("devolve a PK composta na ordem do índice, o tipo da view e as colunas com posição", async () => {
    const pool = obterPoolMysql(conexaoDe(banco));
    const tabelas = await listarTabelasMysql(pool, banco);
    const clientes = tabelas.find((t) => t.nome === "clientes")!;
    expect(clientes.chavePrimaria).toEqual(["org", "id"]);
    expect(tabelas.find((t) => t.nome === "v_pedidos")!.tipo).toBe("view");
    const pedidos = tabelas.find((t) => t.nome === "pedidos")!;
    expect(pedidos.colunas.map((c) => c.nome)).toEqual(["id", "criado", "total", "foto", "nota"]);
    expect(pedidos.colunas.map((c) => c.posicao)).toEqual([1, 2, 3, 4, 5]);
    expect(typeof pedidos.colunas[0]!.nulavel).toBe("boolean");
  });

  it("outro schema não existe: descreverTabela devolve null sem consultar o servidor", async () => {
    const pool = obterPoolMysql(conexaoDe(banco));
    await expect(descreverTabelaMysql(pool, banco, "mysql", "user")).resolves.toBeNull();
  });
});

describe("leitura contra um MySQL de verdade", () => {
  it("datas como texto, bigint como texto, decimal como texto, binário em hex 0x", async () => {
    const pool = obterPoolMysql(conexaoDe(banco));
    const r = await lerTabelaMysql(
      pool,
      banco,
      pedido({ filtros: [{ coluna: "id", operador: "eq", valor: "9007199254740993" }] }),
      PERMITIDAS_PEDIDOS,
    );
    expect(r.linhas).toHaveLength(1);
    expect(r.linhas[0]).toMatchObject({
      id: "9007199254740993",
      criado: "2026-10-08 10:00:00",
      total: "12.50",
      foto: "0xdead",
    });
  });

  it("`contem` ignora caixa e espaços nos dois lados (CB 250 F Twister ← cb250)", async () => {
    const pool = obterPoolMysql(conexaoDe(banco));
    const r = await lerTabelaMysql(
      pool,
      banco,
      pedido({ filtros: [{ coluna: "nota", operador: "contem", valor: "cb250" }] }),
      PERMITIDAS_PEDIDOS,
    );
    expect(r.linhas).toHaveLength(1);
    const c = await lerTabelaMysql(
      pool,
      banco,
      pedido({ filtros: [{ coluna: "nota", operador: "comeca_com", valor: "CB 2" }] }),
      PERMITIDAS_PEDIDOS,
    );
    expect(c.linhas).toHaveLength(1);
  });

  it("`in`, `nulo` e a ordem funcionam e respeitam o limite", async () => {
    const pool = obterPoolMysql(conexaoDe(banco));
    const dois = await lerTabelaMysql(pool, banco, pedido({ filtros: [{ coluna: "id", operador: "in", valor: ["2"] }] }), PERMITIDAS_PEDIDOS);
    expect(dois.linhas.map((l) => l.nota)).toEqual(["João Silva"]);
    const nulo = await lerTabelaMysql(pool, banco, pedido({ filtros: [{ coluna: "foto", operador: "nulo" }] }), PERMITIDAS_PEDIDOS);
    expect(nulo.linhas).toHaveLength(1);
    const um = await lerTabelaMysql(pool, banco, pedido({ ordem: { coluna: "id" }, limite: 1 }), PERMITIDAS_PEDIDOS);
    expect(um.linhas.map((l) => l.id)).toEqual(["2"]);
  });

  it("acento e caixa: o que o servidor faz com 'joao' contra 'João' (registrado, não afirmado)", async () => {
    const pool = obterPoolMysql(conexaoDe(banco));
    const contem = await lerTabelaMysql(pool, banco, pedido({ filtros: [{ coluna: "nota", operador: "contem", valor: "joao" }] }), PERMITIDAS_PEDIDOS);
    const igual = await lerTabelaMysql(pool, banco, pedido({ filtros: [{ coluna: "nota", operador: "eq", valor: "joão silva" }] }), PERMITIDAS_PEDIDOS);
    registrar("F8", `'joao' contem 'João Silva' → ${contem.linhas.length} linha(s); eq 'joão silva' (minúscula) → ${igual.linhas.length} linha(s) (collation padrão do servidor)`);
    expect(contem.linhas.length).toBeGreaterThanOrEqual(0);
  });
});

describe("somente leitura e travas, contra um MySQL de verdade", () => {
  it("INSERT dentro da transação READ ONLY é recusado e nada é gravado; o pool segue usável", async () => {
    const pool = obterPoolMysql(conexaoDe(banco));
    await expect(consultarMysql(pool, `insert into \`${banco}\`.pedidos (id) values (?)`, [99])).rejects.toMatchObject({ errno: 1792 });
    const depois = await consultarMysql<{ n: number | string }>(pool, `select count(*) as n from \`${banco}\`.pedidos`);
    expect(Number(depois.rows[0]!.n)).toBe(2);
  });

  it("as travas de sessão são refeitas a cada empréstimo", async () => {
    const pool = obterPoolMysql(conexaoDe(banco));
    for (let i = 0; i < 3; i++) {
      const r = await consultarMysql<{ a: number | string; b: number | string }>(
        pool,
        "select @@session.max_execution_time as a, @@session.lock_wait_timeout as b",
      );
      expect([Number(r.rows[0]!.a), Number(r.rows[0]!.b)]).toEqual([10_000, 5]);
    }
  });

  it("um SELECT lento não passa do teto de tempo (registrado: a forma de falhar é o que o servidor decide)", async () => {
    const pool = obterPoolMysql(conexaoDe(banco));
    const inicio = Date.now();
    let desfecho = "terminou sem erro";
    try {
      const r = await consultarMysql<Record<string, unknown>>(pool, "select sleep(25) as dormiu");
      desfecho = `terminou sem erro, sleep devolveu ${JSON.stringify(r.rows[0])}`;
    } catch (err) {
      desfecho = `erro ${erroCurto(err)}`;
    }
    const duracao = Date.now() - inicio;
    registrar("C-tempo", `select sleep(25) com max_execution_time=10000 → ${desfecho} em ${duracao} ms`);
    expect(duracao).toBeLessThan(20_000);
  }, 40_000);
});

describe("teste de conexão e aviso de privilégio, contra um MySQL de verdade", () => {
  async function novoLeitor(concessao: string): Promise<UsuarioDeTeste> {
    const u = await criarUsuario(root, concessao);
    usuarios.push(u);
    return u;
  }

  it("usuário só-SELECT de UMA view: conecta e NÃO avisa", async () => {
    const u = await novoLeitor(`select on \`${banco}\`.v_pedidos`);
    const r = await testarConexaoMysql(conexaoDe(banco, { usuario: u }));
    registrar("D5-1", `só-SELECT de uma view → ${JSON.stringify(r)}`);
    expect(r).toEqual({ ok: true });
  });

  it("usuário com SELECT no banco inteiro: avisa leitura ampla", async () => {
    const u = await novoLeitor(`select on \`${banco}\`.*`);
    const r = await testarConexaoMysql(conexaoDe(banco, { usuario: u }));
    registrar("D5-2", `SELECT em banco.* → ${JSON.stringify(r)}`);
    expect(r.ok && r.aviso).toBe(AVISO_LEITURA_AMPLA);
  });

  it("usuário que escreve: avisa escrita", async () => {
    const u = await novoLeitor(`select, insert on \`${banco}\`.pedidos`);
    const r = await testarConexaoMysql(conexaoDe(banco, { usuario: u }));
    registrar("D5-3", `SELECT+INSERT em uma tabela → ${JSON.stringify(r)}`);
    expect(r.ok && r.aviso).toContain(AVISO_ESCRITA);
  });

  it("root (todos os poderes): avisa escrita E leitura ampla", async () => {
    const r = await testarConexaoMysql(conexaoDe(banco));
    registrar("D5-4", `root → ${JSON.stringify(r)}`);
    expect(r.ok && r.aviso).toContain(AVISO_ESCRITA);
    expect(r.ok && r.aviso).toContain(AVISO_LEITURA_AMPLA);
  });

  it("senha errada: falha curta e sem a senha", async () => {
    const r = await testarConexaoMysql(conexaoDe(banco, { password: "senha-errada-xyz" }));
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("senha-errada-xyz");
  });
});
