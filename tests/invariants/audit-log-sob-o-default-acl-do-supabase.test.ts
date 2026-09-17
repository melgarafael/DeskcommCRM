import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

/**
 * O AUDIT LOG É APPEND-ONLY NO BANCO QUE O CLIENTE TEM, NÃO SÓ NO DO GATE — migration 0258.
 *
 * ─── O defeito ──────────────────────────────────────────────────────────────
 *
 * Todo projeto Supabase nasce com um default ACL de TABELAS em `public`:
 *
 *     postgres | r | {…,anon=arwdDxt/postgres,authenticated=arwdDxt/postgres,service_role=arwdDxt/postgres}
 *
 * Então `api_audit_log` nasce com UPDATE, DELETE e TRUNCATE para os três papéis
 * do PostgREST, e o `GRANT` enumerado que o dump emite só acrescenta. Com a
 * service key — que ignora RLS — uma linha escolhida da auditoria era apagada ou
 * reescrita pela REST.
 *
 * ─── Por que um arquivo próprio ─────────────────────────────────────────────
 *
 * Ele nasceu porque o prelude de `scripts/test-db.sh` reproduzia o default ACL
 * do Supabase só para FUNÇÕES: no gate a tabela nascia só com o que o dump
 * concede, e a sonda de `retencao-poda-e-expurgo.test.ts` ficava verde com ou
 * sem o revoke de UPDATE/DELETE. Desde a issue #887 o prelude reproduz também o
 * de TABELAS, e aquela sonda passou a medir o Supabase. Este arquivo continua
 * porque mede o que ela não mede: o privilégio EFETIVO, inclusive o herdado de
 * outro papel; o erro de permissão nos três comandos, e não só a ausência de
 * grant; que INSERT e SELECT seguem de pé; o expurgo e as FKs. E tem controle
 * próprio: sem o bloco da 0258, a simulação reproduz o defeito e apaga a linha.
 *
 * ─── Como ───────────────────────────────────────────────────────────────────
 *
 * 1. `grant all on table public.api_audit_log to anon, authenticated,
 *    service_role` — o que o default ACL do Supabase dá na criação;
 * 2. o bloco da 0258, LIDO do `supabase/baseline.sql` pelo rótulo — o texto que
 *    o self-host aplica, não uma cópia;
 * 3. só então a sonda.
 *
 * O controle (passo 1 sem o passo 2) prova que a simulação reproduz o defeito:
 * sem ele, um `grant` que não pegasse deixaria todos os casos verdes por nada.
 */

const BASELINE = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");

const ROTULO_0258 =
  "-- ---- o audit log perde UPDATE, DELETE e TRUNCATE nos papéis do PostgREST (migration 0258) ----";

/** O bloco rotulado da 0258, do rótulo até o próximo rótulo de apêndice. */
function blocoDa0258(): string {
  const inicio = BASELINE.indexOf(ROTULO_0258);
  if (inicio === -1) throw new Error("rótulo da 0258 não encontrado no baseline");
  if (BASELINE.indexOf(ROTULO_0258, inicio + 1) !== -1) throw new Error("rótulo da 0258 repetido no baseline");
  const fim = BASELINE.indexOf("\n-- ---- ", inicio + ROTULO_0258.length);
  if (fim === -1) throw new Error("fim do bloco da 0258 não encontrado");
  return BASELINE.slice(inicio, fim);
}

/** O que o default ACL de tabelas do Supabase concede a `api_audit_log` ao criá-la. */
const DEFAULT_ACL_DO_SUPABASE =
  "grant all on table public.api_audit_log to anon, authenticated, service_role;";

const PAPEIS = ["anon", "authenticated", "service_role"] as const;

/** Marcador das linhas de resultado: a saída do psql traz também BEGIN, GRANT, REVOKE… */
const MARCA = "SONDA|";

/**
 * Roda `corpo` numa transação desfeita e devolve as linhas marcadas com `MARCA`,
 * sem a marca, na ordem em que saíram.
 */
function sondasDesfeitas(corpo: string): string[] {
  return sql(`begin;\n${corpo}\nrollback;`)
    .split("\n")
    .filter((linha) => linha.startsWith(MARCA))
    .map((linha) => linha.slice(MARCA.length));
}

/** UPDATE/DELETE/TRUNCATE concedidos DIRETAMENTE aos papéis do PostgREST (ou a PUBLIC). */
const SONDA_GRANTS = `
  select '${MARCA}' || coalesce(string_agg(grantee || ':' || privilege_type, ',' order by grantee, privilege_type), '')
    from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'api_audit_log'
     and privilege_type in ('DELETE', 'UPDATE', 'TRUNCATE')
     and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC');`;

/**
 * O privilégio EFETIVO — inclui o herdado de PUBLIC ou de outro papel, que
 * `role_table_grants` filtrado por grantee não enxerga.
 */
const SONDA_EFETIVA = `
  select '${MARCA}' || coalesce(string_agg(p.papel || ':' || p.priv, ',' order by p.papel, p.priv), '')
    from (select papel, priv
            from unnest(array['anon', 'authenticated', 'service_role']) papel,
                 unnest(array['UPDATE', 'DELETE', 'TRUNCATE']) priv) p
   where has_table_privilege(p.papel, 'public.api_audit_log', p.priv);`;

const LINHA = "25800000-0000-4000-8000-0000000000c1";

/** Roda o script e devolve o erro do Postgres, ou `null` se ele passou. */
function erroDo(script: string): string | null {
  try {
    sql(script);
    return null;
  } catch (err) {
    return motivoDoErro(err);
  }
}

describe("migration 0258 sob o default ACL de tabelas do Supabase", () => {
  it("controle: SEM o bloco da 0258, a simulação reproduz o defeito (grants e DELETE 1)", () => {
    const [grants, efetiva, apagadas] = sondasDesfeitas(`
      ${DEFAULT_ACL_DO_SUPABASE}
      ${SONDA_GRANTS}
      ${SONDA_EFETIVA}
      insert into public.api_audit_log (id, action) values ('${LINHA}', 'inv.0258.controle');
      set local role service_role;
      with d as (delete from public.api_audit_log where id = '${LINHA}' returning 1)
      select '${MARCA}' || count(*) from d;
    `);

    for (const papel of PAPEIS) {
      expect(grants, `a simulação não deu DELETE a ${papel}`).toContain(`${papel}:DELETE`);
      expect(grants, `a simulação não deu UPDATE a ${papel}`).toContain(`${papel}:UPDATE`);
    }
    expect(efetiva).toContain("service_role:DELETE");
    expect(apagadas, "service_role não apagou a linha — a simulação não reproduz o Supabase").toBe("1");
  });

  it("COM o bloco da 0258, nenhum dos três papéis tem UPDATE/DELETE/TRUNCATE — nem direto, nem herdado", () => {
    const [grants, efetiva] = sondasDesfeitas(`
      ${DEFAULT_ACL_DO_SUPABASE}
      ${blocoDa0258()}
      ${SONDA_GRANTS}
      ${SONDA_EFETIVA}
    `);
    expect(grants, "grant concedido sobreviveu ao bloco da 0258").toBe("");
    expect(efetiva, "privilégio efetivo sobreviveu ao bloco da 0258").toBe("");
  });

  for (const [comando, dml] of [
    ["DELETE", `delete from public.api_audit_log where id = '${LINHA}'`],
    ["UPDATE", `update public.api_audit_log set action = 'adulterado' where id = '${LINHA}'`],
    ["TRUNCATE", "truncate public.api_audit_log"],
  ] as const) {
    it(`service_role recebe permission denied no ${comando} — o erro, não zero linhas`, () => {
      // service_role ignora RLS: sem o GRANT negado, nada mais o segura. Por isso
      // a asserção é sobre o ERRO, e não sobre a contagem de linhas afetadas.
      const erro = erroDo(`
        begin;
        ${DEFAULT_ACL_DO_SUPABASE}
        ${blocoDa0258()}
        insert into public.api_audit_log (id, action) values ('${LINHA}', 'inv.0258.alvo');
        set local role service_role;
        ${dml};
        rollback;
      `);
      expect(erro, `service_role executou ${comando} em api_audit_log SEM erro`).not.toBeNull();
      expect(erro).toContain("permission denied for table api_audit_log");
    });
  }

  it("INSERT e SELECT seguem de pé para os três (o revoke não é largo demais)", () => {
    // Um `revoke all` deixaria os casos acima verdes e a auditoria MORTA:
    // ninguém mais gravaria linha.
    const [efetiva, inseridas] = sondasDesfeitas(`
      ${DEFAULT_ACL_DO_SUPABASE}
      ${blocoDa0258()}
      select '${MARCA}' || string_agg(p.papel || ':' || p.priv, ',' order by p.papel, p.priv)
        from (select papel, priv
                from unnest(array['anon', 'authenticated', 'service_role']) papel,
                     unnest(array['INSERT', 'SELECT']) priv) p
       where has_table_privilege(p.papel, 'public.api_audit_log', p.priv);
      set local role service_role;
      insert into public.api_audit_log (id, action) values ('${LINHA}', 'inv.0258.insert');
      select '${MARCA}' || count(*) from public.api_audit_log where id = '${LINHA}';
    `);
    expect(efetiva).toBe(
      "anon:INSERT,anon:SELECT,authenticated:INSERT,authenticated:SELECT,service_role:INSERT,service_role:SELECT",
    );
    expect(inseridas).toBe("1");
  });

  it("o expurgo legítimo continua apagando quando chamado por service_role", () => {
    // `fn_expurgar_auditoria_vencida` é security definer de dono `postgres`:
    // o DELETE de dentro dela não depende do grant que a 0258 tirou.
    const [apagadas, sobrou] = sondasDesfeitas(`
      ${DEFAULT_ACL_DO_SUPABASE}
      ${blocoDa0258()}
      insert into public.api_audit_log (id, action, created_at)
        values ('${LINHA}', 'inv.0258.vencida', now() - interval '400 days');
      set local role service_role;
      select '${MARCA}' || public.fn_expurgar_auditoria_vencida(90, 10000);
      select '${MARCA}' || count(*) from public.api_audit_log where id = '${LINHA}';
    `);
    expect(Number(apagadas), "o expurgo não apagou nada").toBeGreaterThanOrEqual(1);
    expect(sobrou, "a linha vencida sobreviveu ao expurgo").toBe("0");
  });

  it("as FKs `on delete set null` seguem funcionando quando service_role apaga org, usuário e token", () => {
    // A ação referencial roda como o DONO de api_audit_log, não como quem apagou
    // a linha referenciada. Se rodasse como quem chamou, apagar uma organização
    // passaria a falhar com permission denied depois da 0258.
    const [depois] = sondasDesfeitas(`
      ${DEFAULT_ACL_DO_SUPABASE}
      ${blocoDa0258()}
      insert into auth.users (id, email) values ('25800000-0000-4000-8000-000000000001', 'fk-0258@invariant.test');
      insert into public.organizations (id, slug, legal_name, display_name)
        values ('25800000-0000-4000-8000-0000000000a1', 'inv-0258-fk', 'Inv 0258', 'Inv 0258');
      insert into public.api_tokens (id, organization_id, created_by, name, prefix, token_hash)
        values ('25800000-0000-4000-8000-0000000000b1', '25800000-0000-4000-8000-0000000000a1',
                '25800000-0000-4000-8000-000000000001', 'inv', 'tok_inv0258', '\\x00');
      insert into public.api_audit_log (id, organization_id, actor_user_id, actor_api_token_id, action)
        values ('${LINHA}', '25800000-0000-4000-8000-0000000000a1', '25800000-0000-4000-8000-000000000001',
                '25800000-0000-4000-8000-0000000000b1', 'inv.0258.fk');
      -- no Supabase quem apaga auth.users é o GoTrue, que também não é dono do audit
      grant delete on auth.users to service_role;
      grant delete on public.api_tokens, public.organizations to service_role;
      set local role service_role;
      delete from public.api_tokens where id = '25800000-0000-4000-8000-0000000000b1';
      delete from public.organizations where id = '25800000-0000-4000-8000-0000000000a1';
      delete from auth.users where id = '25800000-0000-4000-8000-000000000001';
      select '${MARCA}' || coalesce(organization_id::text, 'null') || ',' || coalesce(actor_user_id::text, 'null')
             || ',' || coalesce(actor_api_token_id::text, 'null')
        from public.api_audit_log where id = '${LINHA}';
    `);
    expect(depois, "a linha de auditoria sumiu ou não perdeu as referências").toBe("null,null,null");
  });
});
