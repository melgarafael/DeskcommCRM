/**
 * Ajudante da integração com MySQL de verdade.
 *
 * Cada arquivo de teste cria o próprio banco (`novoBanco`) e o apaga no fim. O
 * usuário `root` do serviço é o único que cria banco/usuário; os usuários de
 * teste (`criarUsuario`) nascem com a concessão que o caso quer medir.
 *
 * `registrar` escreve a MEDIÇÃO no resumo do job (`$GITHUB_STEP_SUMMARY`) e no
 * log: é de lá que a sessão do Claude lê o que o servidor de fato fez.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";

import mysql from "mysql2/promise";

import type { ConexaoExterna, ModoTls } from "@/lib/external-db/types";

export const HOST = process.env.MYSQL_TEST_HOST ?? "127.0.0.1";
export const PORTA = Number(process.env.MYSQL_TEST_PORT ?? "3306");
export const SENHA_ROOT = process.env.MYSQL_TEST_ROOT_PASSWORD ?? "";

export type Root = Awaited<ReturnType<typeof mysql.createConnection>>;

export async function conectarComoRoot(): Promise<Root> {
  return mysql.createConnection({
    host: HOST,
    port: PORTA,
    user: "root",
    password: SENHA_ROOT,
    ssl: { rejectUnauthorized: false },
    multipleStatements: false,
  });
}

export function sufixo(): string {
  return randomUUID().replace(/-/g, "").slice(0, 8);
}

export async function novoBanco(root: Root, prefixo: string): Promise<string> {
  const nome = `${prefixo}_${sufixo()}`;
  await root.query(`create database \`${nome}\` character set utf8mb4`);
  return nome;
}

export async function apagarBanco(root: Root, nome: string): Promise<void> {
  await root.query(`drop database if exists \`${nome}\``).catch(() => undefined);
}

export interface UsuarioDeTeste {
  usuario: string;
  senha: string;
}

/** Cria um usuário com UMA concessão (ex.: "select on `banco`.`v`"). */
export async function criarUsuario(root: Root, concessao: string): Promise<UsuarioDeTeste> {
  const usuario = `u_${sufixo()}`;
  const senha = `S3nha-${sufixo()}`;
  await root.query(`create user '${usuario}'@'%' identified by '${senha}'`);
  await root.query(`grant ${concessao} to '${usuario}'@'%'`);
  return { usuario, senha };
}

export async function apagarUsuario(root: Root, u: UsuarioDeTeste): Promise<void> {
  await root.query(`drop user if exists '${u.usuario}'@'%'`).catch(() => undefined);
}

/** A `ConexaoExterna` de um banco de teste, com o usuário e o modo TLS pedidos. */
export function conexaoDe(
  banco: string,
  extra: Partial<ConexaoExterna> & { usuario?: UsuarioDeTeste; sslMode?: ModoTls } = {},
): ConexaoExterna {
  const { usuario, ...resto } = extra;
  return {
    id: `integracao-${sufixo()}`,
    organizationId: "org-integracao",
    dbType: "mysql",
    label: "MySQL de integração",
    host: HOST,
    port: PORTA,
    database: banco,
    username: usuario?.usuario ?? "root",
    password: usuario?.senha ?? SENHA_ROOT,
    sslMode: "require",
    maxRows: 200,
    maxFilters: 20,
    maxResponseBytes: 30_000,
    chaveDoCliente: null,
    sourceMode: "all",
    fontes: [],
    versao: "integracao",
    ...resto,
  };
}

/** Uma medição: vai para o resumo do job e para o log. NÃO é afirmação. */
export function registrar(id: string, texto: string): void {
  const linha = `- **${id}** — ${texto}`;
  console.info(`[medicao] ${linha}`);
  const resumo = process.env.GITHUB_STEP_SUMMARY;
  if (resumo) {
    try {
      appendFileSync(resumo, `${linha}\n`);
    } catch {
      // sem resumo (execução local ou arquivo travado): o log basta.
    }
  }
}

export function erroCurto(err: unknown): string {
  const e = err as { code?: string; errno?: number; message?: string };
  const codigo = [e.code, e.errno].filter((x) => x !== undefined).join("/");
  return `${codigo || "erro"}: ${(e.message ?? String(err)).split("\n", 1)[0]!.slice(0, 160)}`;
}
