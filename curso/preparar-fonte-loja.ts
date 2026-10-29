/** Fonte fictícia de pedidos: banco separado, sem migrations do aplicativo.
 * Administra apenas Postgres localhost. O endereço LAN é o caminho de leitura
 * visto pelo contêiner do app, submetido também à política real do produto.
 */
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import path from "node:path";
import pg from "pg";
import { cifrarSenha } from "../lib/external-db/credenciais";
import { validarHostDeBanco } from "../lib/external-db/guardas";
import { exigirBancoLocal } from "./seguranca";
import { contextoDaBancada } from "./semear-jornadas";
import { semErro } from "./semear-demonstracao";

const BANCO = "curso_loja_demo", PAPEL = "curso_loja_leitura";
const MARCADOR = "curso-jornadas:loja:v1";
const CONEXAO = "de100000-0000-4000-8000-000000000010";

export function exigirLanDaFonte(host: string | undefined): string {
  if (!host || isIP(host) !== 4) throw new Error("defina CURSO_FONTE_HOST com o IPv4 LAN da bancada");
  const [a, b] = host.split(".").map(Number);
  if (!(a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168))) {
    throw new Error("a fonte fictícia exige IPv4 LAN privado; loopback não é permitido pelo leitor");
  }
  return host;
}

async function main() {
  const ctx = await contextoDaBancada();
  const existente = await ctx.db.from("external_db_connections").select("organization_id").eq("id", CONEXAO).maybeSingle();
  semErro(existente, "conexão da fixture");
  if (existente.data && existente.data.organization_id !== ctx.org) throw new Error("ID da conexão pertence a outra organização");
  const host = exigirLanDaFonte(process.env.CURSO_FONTE_HOST);
  const port = Number(process.env.CURSO_FONTE_PORT ?? "5432");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("porta da fonte inválida");
  const permitido = await validarHostDeBanco(host);
  if (!permitido.ok) throw new Error("host da fonte recusado pela política do aplicativo");
  const url = new URL(exigirBancoLocal(process.env.SUPABASE_DB_URL));
  const senha = randomBytes(24).toString("hex");
  const cifrada = cifrarSenha(senha); // valida a chave antes de alterar qualquer banco
  const admin = new pg.Client({ connectionString: url.href });
  await admin.connect();
  try {
    // Mesma identidade da API: uma URL local errada também deve falhar antes de escrever.
    const org = await admin.query("select id from public.organizations where id=$1", [ctx.org]);
    if (org.rowCount !== 1) throw new Error("Postgres local não corresponde à bancada Supabase");
    const banco = await admin.query("select pg_get_userbyid(datdba)=current_user as dono, shobj_description(oid,'pg_database') as marcador from pg_database where datname=$1", [BANCO]);
    const papel = await admin.query("select shobj_description(oid,'pg_authid') as marcador, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls from pg_roles where rolname=$1", [PAPEL]);
    if (banco.rows[0] && (!banco.rows[0].dono || banco.rows[0].marcador !== MARCADOR)) throw new Error("banco existente sem ownership da fixture; nada foi alterado");
    if (papel.rows[0] && (papel.rows[0].marcador !== MARCADOR || ["rolsuper", "rolcreatedb", "rolcreaterole", "rolreplication", "rolbypassrls"].some((k) => papel.rows[0][k]))) throw new Error("papel existente não pertence à fixture de leitura; nada foi alterado");
    const vinculos = await admin.query("select 1 from pg_auth_members m join pg_roles r on r.oid=m.member where r.rolname=$1", [PAPEL]);
    if (vinculos.rowCount) throw new Error("papel da fixture herda outro papel; conexão recusada");
    // Nomes são constantes privadas do helper, nunca input interpolado do operador.
    if (!banco.rowCount) {
      await admin.query(`create database ${BANCO}`);
      await admin.query(`comment on database ${BANCO} is '${MARCADOR}'`);
    }
    if (!papel.rowCount) {
      await admin.query(`create role ${PAPEL} login nosuperuser nocreatedb nocreaterole noreplication nobypassrls`);
      await admin.query(`comment on role ${PAPEL} is '${MARCADOR}'`);
    }
    // senha é hex gerado em memória, não input SQL e nunca sai para log/arquivo.
    await admin.query(`alter role ${PAPEL} password '${senha}'`);
    url.pathname = `/${BANCO}`;
    const fonte = new pg.Client({ connectionString: url.href });
    await fonte.connect();
    try {
      await fonte.query("begin");
      await fonte.query("create table if not exists public.pedidos (telefone text not null, pedido text primary key, produto text, situacao text, rastreio text)");
      // Só os dois exemplos; não há TRUNCATE nem DELETE da origem.
      await fonte.query(`insert into public.pedidos (telefone,pedido,produto,situacao,rastreio) values ($1,$2,$3,$4,$5),($6,$7,$8,$9,$10)
        on conflict(pedido) do update set telefone=excluded.telefone,produto=excluded.produto,situacao=excluded.situacao,rastreio=excluded.rastreio`,
      ["5511000000997", "CT-4729", "Mochila Horizonte", "Despachado", "RASTREIO-EXEMPLO-4729", "5511000000001", "CT-4730", "Barraca Caminho", "Em separação", "CONTROLE-DE-OUTRO-CLIENTE"]);
      await fonte.query(`grant connect on database ${BANCO} to ${PAPEL}`);
      await fonte.query(`grant usage on schema public to ${PAPEL}`);
      await fonte.query(`revoke all on public.pedidos from ${PAPEL}`);
      await fonte.query(`grant select on public.pedidos to ${PAPEL}`);
      await fonte.query("analyze public.pedidos");
      await fonte.query("commit");
    } catch (e) { await fonte.query("rollback"); throw e; }
    finally { await fonte.end(); }
    semErro(await ctx.db.from("platform_config").upsert({ chave: "MODULO_BANCO_EXTERNO", valor: "ligado", eh_segredo: false, semeado_do_env: false, updated_by: ctx.pessoa.helena }, { onConflict: "chave" }), "recurso da fonte");
    semErro(await ctx.db.from("external_db_connections").upsert({ id: CONEXAO, organization_id: ctx.org,
      label: "Casa das Trilhas — pedidos (demonstração)", db_type: "postgres", host, port, database_name: BANCO, username: PAPEL, ...cifrada,
      ssl_mode: "disable", enabled: true, source_mode: "list", created_by: ctx.pessoa.helena, customer_key_kind: "phone", customer_key_column: "telefone",
      sources: [{ schema: "public", tabela: "pedidos", colunas: ["telefone", "pedido", "produto", "situacao", "rastreio"], descricao: "Pedidos fictícios da loja; leitura limitada ao cliente do atendimento." }],
    }, { onConflict: "id" }), "fonte fictícia");
    console.info("Fonte fictícia local preparada; senha aleatória somente cifrada na bancada.");
  } finally { await admin.end(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch(() => { console.error("Preparação recusada. Confira destino local, ownership da fixture e configuração privada; nenhum segredo é exibido."); process.exitCode = 1; });
}
