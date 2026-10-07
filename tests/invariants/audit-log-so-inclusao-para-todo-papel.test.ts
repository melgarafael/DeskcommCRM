import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

/**
 * O AUDIT LOG É SÓ-INCLUSÃO PARA TODO PAPEL QUE NÃO SEJA O DONO — migration 0525.
 *
 * A 0258 revogou UPDATE, DELETE e TRUNCATE de `api_audit_log` numa lista fixa
 * (public, anon, authenticated, service_role) e o invariante dela
 * (`audit-log-sob-o-default-acl-do-supabase`) mede só esses quatro. O papel que
 * o guia do self-host manda criar — `agent_worker`, com DML em todas as tabelas
 * de `public` — ficava fora da lista e fora da sonda.
 *
 * Dois caminhos, as duas pontas medidas aqui:
 *
 * 1. a RECEITA do guia, LIDA de `docs/deploy-selfhost/README.md` — o texto que o
 *    operador copia, não uma cópia dele;
 * 2. a instalação que já seguiu a receita antiga e só roda o `update.sh`: o bloco
 *    da 0525, LIDO do `supabase/baseline.sql` pelo rótulo, tem de curá-la com
 *    qualquer nome de papel.
 *
 * Cada ponta tem controle: sem o revoke, a simulação reproduz o privilégio.
 */

const RAIZ = process.cwd();
const BASELINE = readFileSync(join(RAIZ, "supabase", "baseline.sql"), "utf8");
const GUIA = readFileSync(join(RAIZ, "docs", "deploy-selfhost", "README.md"), "utf8");

const ROTULO_0525 =
  "-- ---- o audit log é só-inclusão para TODO papel que não seja o dono (migration 0525) ----";

/** O bloco rotulado da 0525, do rótulo até o próximo rótulo de apêndice (ou o fim). */
function blocoDa0525(): string {
  const inicio = BASELINE.indexOf(ROTULO_0525);
  if (inicio === -1) throw new Error("rótulo da 0525 não encontrado no baseline");
  if (BASELINE.indexOf(ROTULO_0525, inicio + 1) !== -1)
    throw new Error("rótulo da 0525 repetido no baseline");
  const fim = BASELINE.indexOf("\n-- ---- ", inicio + ROTULO_0525.length);
  return BASELINE.slice(inicio, fim === -1 ? undefined : fim);
}

/** O bloco ```sql do guia que cria o papel do worker. */
function receitaDoGuia(): string {
  const blocos = [...GUIA.matchAll(/```sql\n([\s\S]*?)```/g)]
    .map((m) => m[1] ?? "")
    .filter((b) => b.includes("create role agent_worker"));
  const [bloco] = blocos;
  if (blocos.length !== 1 || bloco === undefined) {
    throw new Error(`esperava 1 bloco sql com 'create role agent_worker', achei ${blocos.length}`);
  }
  return bloco;
}

const MARCA = "SONDA|";

function sondasDesfeitas(corpo: string): string[] {
  return sql(`begin;\n${corpo}\nrollback;`)
    .split("\n")
    .filter((linha) => linha.startsWith(MARCA))
    .map((linha) => linha.slice(MARCA.length));
}

/** Privilégios EFETIVOS de `papel` em `tabela`, dentre `privs`, em ordem. */
function sondaPrivs(papel: string, tabela: string, privs: readonly string[]): string {
  return `
    select '${MARCA}' || coalesce(string_agg(p, ',' order by p), '')
      from unnest(array[${privs.map((p) => `'${p}'`).join(", ")}]) p
     where has_table_privilege('${papel}', '${tabela}', p);`;
}

/** Quem, além do dono, tem grant direto de UPDATE/DELETE/TRUNCATE em api_audit_log. */
const SONDA_GRANTS_DIRETOS = `
  select '${MARCA}' || coalesce(string_agg(distinct case when a.grantee = 0 then 'PUBLIC' else r.rolname end, ',' ), '')
    from pg_class c
    cross join lateral aclexplode(c.relacl) a
    left join pg_roles r on r.oid = a.grantee
   where c.oid = 'public.api_audit_log'::regclass
     and a.grantee <> c.relowner
     and a.privilege_type in ('UPDATE', 'DELETE', 'TRUNCATE');`;

const ADULTERA = ["DELETE", "TRUNCATE", "UPDATE"] as const;
const GRAVA = ["INSERT", "SELECT"] as const;

describe("api_audit_log é só-inclusão para todo papel (migration 0525)", () => {
  it("controle: a forma antiga da receita dá UPDATE, DELETE e TRUNCATE a um papel fora da lista da 0258", () => {
    const [antes] = sondasDesfeitas(`
      create role inv_0525_worker nologin;
      grant select, insert, update, delete on all tables in schema public to inv_0525_worker;
      grant truncate on table public.api_audit_log to inv_0525_worker;
      ${sondaPrivs("inv_0525_worker", "public.api_audit_log", ADULTERA)}
    `);
    expect(
      antes,
      "a simulação não reproduziu o privilégio — os casos abaixo seriam verdes por nada",
    ).toBe("DELETE,TRUNCATE,UPDATE");
  });

  it("o bloco da 0525 cura a instalação que seguiu a receita antiga, com qualquer nome de papel e PUBLIC", () => {
    const [adultera, grava, outraTabela, diretos] = sondasDesfeitas(`
      create role inv_0525_worker nologin;
      grant select, insert, update, delete on all tables in schema public to inv_0525_worker;
      grant truncate on table public.api_audit_log to inv_0525_worker;
      grant delete on table public.api_audit_log to public;
      ${blocoDa0525()}
      ${sondaPrivs("inv_0525_worker", "public.api_audit_log", ADULTERA)}
      ${sondaPrivs("inv_0525_worker", "public.api_audit_log", GRAVA)}
      ${sondaPrivs("inv_0525_worker", "public.crm_leads", ["DELETE", "UPDATE"])}
      ${SONDA_GRANTS_DIRETOS}
    `);
    expect(adultera, "o papel do operador segue podendo adulterar a auditoria").toBe("");
    expect(grava, "o revoke foi largo demais: o worker deixou de gravar/ler auditoria").toBe(
      "INSERT,SELECT",
    );
    expect(outraTabela, "o revoke vazou para outra tabela").toBe("DELETE,UPDATE");
    expect(diretos, "sobrou grant direto de UPDATE/DELETE/TRUNCATE fora do dono").toBe("");
  });

  it("a receita do guia, como publicada, deixa o agent_worker só com INSERT e SELECT na auditoria", () => {
    const [adultera, grava, outraTabela] = sondasDesfeitas(`
      ${receitaDoGuia()}
      ${sondaPrivs("agent_worker", "public.api_audit_log", ADULTERA)}
      ${sondaPrivs("agent_worker", "public.api_audit_log", GRAVA)}
      ${sondaPrivs("agent_worker", "public.crm_leads", ["DELETE", "UPDATE"])}
    `);
    expect(adultera, "a receita do guia dá ao agent_worker poder de adulterar a auditoria").toBe(
      "",
    );
    expect(grava).toBe("INSERT,SELECT");
    expect(outraTabela, "a receita deixou de dar ao worker o DML de que ele precisa").toBe(
      "DELETE,UPDATE",
    );
  });

  it("o agent_worker da receita recebe permission denied no DELETE — o erro, não zero linhas", () => {
    // agent_worker é bypassrls: sem o grant negado, nada mais o segura.
    let erro: string | null = null;
    try {
      sql(`
        begin;
        ${receitaDoGuia()}
        insert into public.api_audit_log (id, action) values ('25250000-0000-4000-8000-0000000000c1', 'inv.0525.alvo');
        set local role agent_worker;
        delete from public.api_audit_log where id = '25250000-0000-4000-8000-0000000000c1';
        rollback;
      `);
    } catch (err) {
      erro = motivoDoErro(err);
    }
    expect(erro, "agent_worker apagou linha de api_audit_log SEM erro").not.toBeNull();
    expect(erro).toContain("permission denied for table api_audit_log");
  });
});
