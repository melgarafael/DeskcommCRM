import { beforeAll, describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

/**
 * OS NOMES DA EQUIPE NUMA CONSULTA SÓ — migration 9314, fatia 3 da #4326.
 *
 * ─── O que este arquivo vigia, e por que no BANCO ───────────────────────────
 *
 * `nomesDosAtendentesCom` (lib/users/nome-do-atendente.ts) trocou N chamadas
 * HTTP ao endpoint admin do GoTrue (`auth.admin.getUserById`, uma por pessoa)
 * por UMA consulta a `public.fn_nomes_dos_membros(p_org, p_ids)`. O dublê do
 * unitário prova que o HTTP chegou a zero; ele NÃO prova a regra que mora no
 * SQL — e é ela que decide quem ganha nome. Aqui a função roda de verdade,
 * sobre fixtures sintéticas, e mede:
 *
 *   1. REGRA DE VÍNCULO — membro ativo, membro com `revoked_at` (quem saiu
 *      mantém o nome no histórico), membro sem `full_name` (nome nulo, linha
 *      presente) e id de OUTRA organização (sem linha). Id inexistente em
 *      `auth.users` também não inventa linha. É a mesma regra de
 *      `membrosDaOrganizacao`, sem filtro de revogação.
 *   2. ID REPETIDO não duplica linha: a lista chega com o mesmo id duas vezes.
 *   3. COLUNAS PREVISTAS — `pg_get_function_result` é exatamente
 *      `TABLE(user_id uuid, full_name text, email text)`: nada de
 *      `user_metadata` inteiro, telefone ou o que mais alguém acrescente sem
 *      decisão (LGPD).
 *   4. QUEM EXECUTA — `service_role` sim; `anon` e `authenticated` NÃO, medido
 *      por `has_function_privilege` E por tentativa real (42501). A função é
 *      `security definer` (lê `auth.users` com privilégio do dono), então o
 *      REVOKE é a única cerca que impede a sessão de usuário de ler o cadastro.
 *   5. A FORMA — `stable`, `security definer`, `search_path = public`.
 *
 * A fixture entra como `postgres` (dono), como o `scripts/test-db.sh` aplica o
 * baseline; por isso o caso do `anon`/`authenticated` precisa do `set role`
 * explícito, que é o mesmo caminho do PostgREST.
 */

const U = "93140000-0000-4000-8000";
const u = (n: number) => `${U}-${String(n).padStart(12, "0")}`;

const ORG_A = u(1);
const ORG_B = u(2);
const ANA = u(11); // membro ativo, com full_name
const BIA = u(12); // vínculo REVOGADO, com full_name (quem saiu)
const CAIO = u(13); // membro só de OUTRA organização
const DORA = u(14); // membro ativo, SEM full_name
const FORA = u(15); // existe em auth.users, sem vínculo nenhum

function chamada(org: string, ids: string[]): string {
  const lista = ids.map((id) => `'${id}'::uuid`).join(", ");
  return `select user_id::text || '|' || coalesce(full_name, '∅') || '|' || coalesce(email, '∅')
            from public.fn_nomes_dos_membros('${org}'::uuid, array[${lista}]::uuid[])
           order by user_id`;
}

function linhas(script: string): string[] {
  return sql(script)
    .split("\n")
    .filter((linha) => linha !== "" && linha !== "SET");
}

function comoservidor(script: string): string {
  return linhas(`set role service_role;\n${script}`).join("\n");
}

/** O stderr com SQLSTATE (VERBOSITY verbose), ou "" se o script passou. */
function negado(script: string): string {
  try {
    sql(`\\set VERBOSITY verbose\n${script}`);
    return "";
  } catch (err) {
    return motivoDoErro(err);
  }
}

beforeAll(() => {
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG_A}', 'inv-9314-a', 'Inv 9314 A', 'Inv 9314 A'),
             ('${ORG_B}', 'inv-9314-b', 'Inv 9314 B', 'Inv 9314 B')
      on conflict (id) do nothing;

    insert into auth.users (id, email, raw_user_meta_data) values
      ('${ANA}',  'ana@invariant.test',  '{"full_name":"Ana Souza"}'::jsonb),
      ('${BIA}',  'bia@invariant.test',  '{"full_name":"Bia Lima"}'::jsonb),
      ('${CAIO}', 'caio@invariant.test', '{"full_name":"Caio Reis"}'::jsonb),
      ('${DORA}', 'dora@invariant.test', '{}'::jsonb),
      ('${FORA}', 'fora@invariant.test', '{"full_name":"Fora da Equipe"}'::jsonb)
      on conflict (id) do nothing;

    insert into public.user_organizations (user_id, organization_id, role, accepted_at, revoked_at) values
      ('${ANA}',  '${ORG_A}', 'agent',   now(), null),
      ('${BIA}',  '${ORG_A}', 'agent',   now() - interval '90 days', now() - interval '10 days'),
      ('${CAIO}', '${ORG_B}', 'manager', now(), null),
      ('${DORA}', '${ORG_A}', 'agent',   now(), null)
      on conflict do nothing;
  `);
});

describe("fn_nomes_dos_membros — a regra de vínculo, no banco", () => {
  it("membro ativo e desligado ganham nome; sem full_name vem nulo; outra org e id solto não vêm", () => {
    const linhas = comoservidor(chamada(ORG_A, [ANA, BIA, DORA, CAIO, FORA]));

    expect(linhas.split("\n")).toEqual([
      `${ANA}|Ana Souza|ana@invariant.test`,
      `${BIA}|Bia Lima|bia@invariant.test`,
      `${DORA}|∅|dora@invariant.test`,
    ]);
  });

  it("a organização é a do argumento: o mesmo id, pedido pela outra org, volta só para quem é dela", () => {
    expect(comoservidor(chamada(ORG_B, [ANA, BIA, CAIO, DORA])).split("\n")).toEqual([
      `${CAIO}|Caio Reis|caio@invariant.test`,
    ]);
  });

  it("id repetido na lista não duplica linha", () => {
    const linhas = comoservidor(chamada(ORG_A, [ANA, ANA, ANA]));
    expect(linhas.split("\n")).toEqual([`${ANA}|Ana Souza|ana@invariant.test`]);
  });

  it("lista vazia e lista nula devolvem zero linhas", () => {
    expect(
      comoservidor(`select count(*) from public.fn_nomes_dos_membros('${ORG_A}'::uuid, '{}'::uuid[])`),
    ).toBe("0");
    expect(
      comoservidor(`select count(*) from public.fn_nomes_dos_membros('${ORG_A}'::uuid, null)`),
    ).toBe("0");
  });

  it("devolve SÓ as colunas previstas (user_id, full_name, email)", () => {
    expect(
      comoservidor(`select pg_get_function_result('public.fn_nomes_dos_membros(uuid,uuid[])'::regprocedure)`),
    ).toBe("TABLE(user_id uuid, full_name text, email text)");
  });

  it("é stable, security definer e com search_path fixo", () => {
    const forma = comoservidor(`
      select p.provolatile::text || '|' || p.prosecdef::text || '|' || coalesce(array_to_string(p.proconfig, ','), '∅')
        from pg_proc p
       where p.oid = 'public.fn_nomes_dos_membros(uuid,uuid[])'::regprocedure
    `);
    expect(forma).toBe("s|true|search_path=public");
  });
});

describe("fn_nomes_dos_membros — quem pode executar", () => {
  const alvo = "public.fn_nomes_dos_membros(uuid,uuid[])";

  it("service_role tem EXECUTE; anon e authenticated NÃO", () => {
    expect(sql(`select has_function_privilege('service_role', '${alvo}', 'execute')::text`)).toBe("true");
    expect(sql(`select has_function_privilege('anon', '${alvo}', 'execute')::text`)).toBe("false");
    expect(sql(`select has_function_privilege('authenticated', '${alvo}', 'execute')::text`)).toBe("false");
  });

  it("a sessão de usuário (authenticated) é BARBADA na execução, não só no grant", () => {
    const erro = negado(`set role authenticated;\nselect * from public.fn_nomes_dos_membros('${ORG_A}'::uuid, array['${ANA}'::uuid]);`);
    expect(erro).toContain("42501");
  });

  it("o anon é BARBADO na execução", () => {
    const erro = negado(`set role anon;\nselect * from public.fn_nomes_dos_membros('${ORG_A}'::uuid, array['${ANA}'::uuid]);`);
    expect(erro).toContain("42501");
  });
});
