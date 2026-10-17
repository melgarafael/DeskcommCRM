import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import mysql from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  configMysql,
  consultarMysql,
  fecharTodosOsPoolsMysql,
  obterPoolMysql,
} from "@/lib/external-db/dialetos/mysql/conexao";
import { listarTabelasMysql } from "@/lib/external-db/dialetos/mysql/introspeccao";
import type { ModoTls } from "@/lib/external-db/types";

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

beforeAll(async () => {
  root = await conectarComoRoot();
  banco = await novoBanco(root, "medicao");
});

afterAll(async () => {
  await fecharTodosOsPoolsMysql();
  for (const u of usuarios) await apagarUsuario(root, u);
  await apagarBanco(root, banco);
  await root.end().catch(() => undefined);
});

describe("C1a — START TRANSACTION READ ONLY numa tabela MyISAM", () => {
  it("registra se o servidor recusou ou gravou", async () => {
    await root.query(`create table \`${banco}\`.t_myisam (id int) engine=MyISAM`);
    await root.query(`create table \`${banco}\`.t_innodb (id int) engine=InnoDB`);
    const pool = obterPoolMysql(conexaoDe(banco)); // root: PODE escrever, só a transação READ ONLY segura
    const resultado: string[] = [];
    for (const tabela of ["t_innodb", "t_myisam"]) {
      let desfecho: string;
      try {
        await consultarMysql(pool, `insert into \`${banco}\`.\`${tabela}\` values (1)`);
        desfecho = "INSERT passou sem erro";
      } catch (err) {
        desfecho = `INSERT recusado (${erroCurto(err)})`;
      }
      const [linhas] = (await root.query(`select count(*) as n from \`${banco}\`.\`${tabela}\``)) as unknown as [Array<{ n: number }>];
      resultado.push(`${tabela}: ${desfecho}; linhas gravadas = ${linhas[0]!.n}`);
    }
    registrar("C1a", resultado.join(" | "));
    expect(resultado).toHaveLength(2);
  });
});

describe("C1b — LOAD DATA LOCAL INFILE com e sem a flag -LOCAL_FILES", () => {
  it("registra o que cada configuração faz com o pedido de arquivo local", async () => {
    await root.query("set global local_infile = 1");
    await root.query(`create table \`${banco}\`.t_c1b (linha text)`);
    const dir = mkdtempSync(join(tmpdir(), "c1b-"));
    const arquivo = join(dir, "segredo.txt");
    writeFileSync(arquivo, "conteudo-da-maquina-do-cliente\n");
    const sql = `load data local infile '${arquivo}' into table \`${banco}\`.t_c1b`;
    const base = configMysql(conexaoDe(banco));

    const relatorio: string[] = [];
    for (const [rotulo, opcoes] of [
      ["com -LOCAL_FILES (a nossa configuração)", base],
      ["SEM a flag (controle)", { ...base, flags: [] as string[] }],
    ] as const) {
      const c = await mysql.createConnection({ ...opcoes, database: banco });
      let desfecho: string;
      try {
        await c.query(sql);
        desfecho = "o servidor aceitou o LOAD DATA LOCAL";
      } catch (err) {
        desfecho = `recusado (${erroCurto(err)})`;
      }
      const [linhas] = (await c.query(`select count(*) as n from t_c1b`)) as unknown as [Array<{ n: number }>];
      await c.query("delete from t_c1b").catch(() => undefined);
      await c.end();
      relatorio.push(`${rotulo}: ${desfecho}; linhas carregadas = ${linhas[0]!.n}`);
    }
    registrar("C1b", relatorio.join(" | "));
    expect(relatorio).toHaveLength(2);
  });
});

describe("C1c — o que o mysql2 faz em cada modo de TLS", () => {
  it("registra, para cada modo, se conecta, se cifra e o erro quando falha", async () => {
    const modos: ModoTls[] = ["disable", "prefer", "require", "verify-ca", "verify-full"];
    const linhas: string[] = [];
    for (const modo of modos) {
      const cfg = configMysql(conexaoDe(banco, { sslMode: modo }));
      let desfecho: string;
      try {
        const c = await mysql.createConnection({ ...cfg, database: banco });
        const [rs] = (await c.query("show session status like 'Ssl_cipher'")) as unknown as [Array<{ Value: string }>];
        desfecho = `conectou; Ssl_cipher=${rs[0]?.Value ? rs[0].Value : "(vazio: sem TLS)"}`;
        await c.end();
      } catch (err) {
        desfecho = `falhou (${erroCurto(err)})`;
      }
      linhas.push(`${modo} (opção ssl ${"ssl" in cfg ? "presente" : "OMITIDA"}) → ${desfecho}`);
    }
    registrar("C1c", linhas.join(" | "));
    expect(linhas).toHaveLength(modos.length);
  });
});

describe("C1d — espera por trava de metadados (ALTER TABLE pendurado no banco do cliente)", () => {
  it("registra quanto o SELECT espera e com que erro, com max_execution_time=10 s e lock_wait_timeout=5 s", async () => {
    await root.query(`create table \`${banco}\`.t_mdl (id int) engine=InnoDB`);
    await root.query(`insert into \`${banco}\`.t_mdl values (1)`);
    const a = await conectarComoRoot(); // segura uma trava de metadados compartilhada
    const b = await conectarComoRoot(); // o ALTER fica esperando a trava exclusiva
    await a.query("start transaction");
    await a.query(`select * from \`${banco}\`.t_mdl`);
    const alter = b.query(`alter table \`${banco}\`.t_mdl add column x int`).catch((e) => e);
    await new Promise((r) => setTimeout(r, 800)); // dá tempo de o ALTER entrar na fila

    const pool = obterPoolMysql(conexaoDe(banco));
    const inicio = Date.now();
    let desfecho = "o SELECT terminou sem erro";
    try {
      await consultarMysql(pool, `select * from \`${banco}\`.t_mdl`);
    } catch (err) {
      desfecho = `o SELECT falhou (${erroCurto(err)})`;
    }
    const duracao = Date.now() - inicio;
    await a.query("commit");
    await alter;
    await a.end();
    await b.end();
    registrar("C1d", `${desfecho} depois de ${duracao} ms esperando atrás do ALTER`);
    expect(duracao).toBeLessThan(25_000);
  }, 60_000);
});

describe("C1f — custo do catálogo num banco 'tipo WordPress' (muitas tabelas e colunas)", () => {
  it("registra o tempo de listarTabelas com 300 tabelas × 30 colunas", async () => {
    const nomeColunas = Array.from({ length: 30 }, (_, i) => `c${i} varchar(40)`).join(", ");
    const nomeDoBanco = await novoBanco(root, "wp");
    try {
      for (let i = 0; i < 300; i++) {
        await root.query(`create table \`${nomeDoBanco}\`.wp_t${i} (id bigint not null primary key, ${nomeColunas})`);
      }
      const pool = obterPoolMysql(conexaoDe(nomeDoBanco));
      const inicio = Date.now();
      const tabelas = await listarTabelasMysql(pool, nomeDoBanco);
      const duracao = Date.now() - inicio;
      const colunas = tabelas.reduce((s, t) => s + t.colunas.length, 0);
      registrar("C1f", `listarTabelas: ${tabelas.length} tabelas, ${colunas} colunas, ${duracao} ms`);
      expect(tabelas).toHaveLength(300);
      expect(duracao).toBeLessThan(60_000);
    } finally {
      await apagarBanco(root, nomeDoBanco);
    }
  }, 180_000);
});

describe("C1g — o catálogo respeita os privilégios do usuário?", () => {
  it("registra o que um usuário só-SELECT de UMA view enxerga no catálogo", async () => {
    await root.query(`create table \`${banco}\`.privada (id int, segredo varchar(20))`);
    await root.query(`create table \`${banco}\`.publica (id int, nome varchar(20))`);
    await root.query(`create view \`${banco}\`.v_publica as select id, nome from \`${banco}\`.publica`);
    const u = await criarUsuario(root, `select on \`${banco}\`.v_publica`);
    usuarios.push(u);
    const pool = obterPoolMysql(conexaoDe(banco, { usuario: u }));
    const tabelas = await listarTabelasMysql(pool, banco);
    registrar("C1g", `o usuário só-SELECT da view v_publica enxerga no catálogo: [${tabelas.map((t) => t.nome).join(", ")}]`);
    expect(Array.isArray(tabelas)).toBe(true);
  });
});
