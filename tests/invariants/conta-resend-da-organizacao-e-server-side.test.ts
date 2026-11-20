import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

/**
 * A conta Resend da organização (#3287, migration 0795) é DENY-ALL para o
 * navegador — e isto se mede, não se declara.
 *
 * ## O que a linha guarda
 *
 * `organization_resend_accounts` tem UMA linha por organização: a chave da
 * conta Resend DELA, cifrada em AES-256-GCM (`api_key_ciphertext` +
 * `api_key_iv` + `api_key_tag`, bytea), os 4 últimos caracteres da chave
 * (`api_key_last4` — o que a tela mostra para a pessoa reconhecer qual chave
 * está conectada, sem nunca devolver a chave) e o endereço de REMETENTE no
 * domínio VERIFICADO da conta (`from_email`). Com a conta conectada o e-mail
 * da automação sai pelo `from` da organização; sem conta, o roteador da
 * plataforma entrega byte a byte como sempre.
 *
 * ## Por que NÃO está em `TABLES` (rls-isolation.test.ts)
 *
 * Mesmo motivo declarado de `ad_platform_connections` (0213): a pergunta
 * daquela lista pressupõe que `authenticated` ALCANÇA a tabela e é filtrado
 * por policy. Aqui `authenticated` não alcança nada — RLS ligada, ZERO
 * policies, `revoke all` de anon/authenticated (0795). Rodar `countAs` aqui
 * devolveria `permission denied` em vez de `0`, o caso ficaria vermelho, e a
 * "correção" natural — criar policy de tenant — passaria a SERVIR pelo
 * PostgREST a tabela que guarda a chave que ESCREVE e-mail com o domínio do
 * cliente. Deny-all é MAIS restritivo que isolamento por tenant, não menos.
 * A prova dela é ESTE arquivo.
 *
 * ## Por que RLS-sem-policy não basta sozinha
 *
 * O `supabase/baseline.sql` traz `ALTER DEFAULT PRIVILEGES … GRANT ALL ON
 * TABLES TO anon` / `… TO authenticated`, e eles valem para toda tabela criada
 * DEPOIS deles — isto é, para todo apêndice novo. **Tabela nova nasce
 * concedida.** Com RLS ligada e zero policies, `anon` receberia zero linhas
 * mesmo SEM o revoke, e um teste que só contasse linhas passaria. Por isso
 * aqui se mede PRIVILÉGIO (o que sobra no dia em que alguém acrescentar uma
 * policy) **e** comportamento (`permission denied`, que distingue "a policy
 * barrou" de "o privilégio não existe") — e os dois degraus que sobram: RLS
 * ligada e zero policies.
 *
 * ## O que se mede, em uma frase
 *
 * A linha semeada numa organização NÃO é lida por `authenticated` (nem pelo
 * membro da PRÓPRIA organização, com JWT de verdade) nem por `anon` — e a
 * chave cifrada nunca sai em payload nenhum: `authenticated` é barrado até em
 * `api_key_last4`, o único texto da chave que a tabela tem, e nenhuma view
 * expõe a tabela. Quem lê o estado para a tela é o servidor, com o admin
 * client, selecionando só as colunas seguras.
 *
 * Molde: `lgpd-marca-de-apagamento.test.ts` (RLS ligada, ZERO policies,
 * anon/authenticated sem privilégio, membro com JWT authenticated recusado) e
 * o desenho deny-all de `credencial-de-anuncios-e-server-side.test.ts`.
 */

/** Organização dona da conta, organização vizinha, e o membro da dona. */
const ORG_A = "3287a000-0000-4000-8000-00000000000a";
const ORG_B = "3287a000-0000-4000-8000-00000000000b";
const MEMBRO_A = "3287a000-1111-4000-8000-000000000001";

/**
 * A chave CRUA que a pessoa "colou". Ela NUNCA deve aparecer em nenhuma coluna
 * da linha — o que se grava é a cifra, e o last4 é a única derivação dela que
 * existe em texto.
 */
const CHAVE_CRUA = "re_3287_chave_crua_que_nunca_pode_vazar";
/** Os 4 últimos da chave acima — é o que a tela pode mostrar. */
const LAST4 = "azar";

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values ('${MEMBRO_A}', 'conta-resend-a@invariant.test')
      on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'conta-resend-a', 'Conta Resend A', 'Conta Resend A'),
      ('${ORG_B}', 'conta-resend-b', 'Conta Resend B', 'Conta Resend B')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${MEMBRO_A}', '${ORG_A}', 'admin', now()) on conflict do nothing;
    -- A linha da conta, no MESMO formato que a action grava: cifra bytea +
    -- last4 + from_email. A cifra aqui é artificial (md5), mas o contrato que
    -- o teste mede é o da GRAVAÇÃO: bytea opaco, chave em claro em lugar
    -- nenhum, last4 de exatamente 4 caracteres.
    insert into public.organization_resend_accounts
        (organization_id, api_key_ciphertext, api_key_iv, api_key_tag, api_key_last4, from_email)
      values
        ('${ORG_A}',
         decode(md5('cifra-3287'), 'hex'),
         decode(md5('iv-3287'), 'hex'),
         decode(md5('tag-3287'), 'hex'),
         '${LAST4}',
         'envio@empresa-a.invariant.test')
      on conflict (organization_id) do nothing;
  `);
});

afterAll(() => {
  // Só os ids desta fixture: não deixar credencial/tenant para outra suíte.
  sql(`
    delete from public.organization_resend_accounts where organization_id in ('${ORG_A}', '${ORG_B}');
    delete from public.user_organizations where user_id = '${MEMBRO_A}' and organization_id in ('${ORG_A}', '${ORG_B}');
    delete from public.organizations where id in ('${ORG_A}', '${ORG_B}');
    delete from auth.users where id = '${MEMBRO_A}';
  `);
});

describe("a conta Resend da organização é deny-all para o navegador", () => {
  it("a tabela EXISTE no baseline — controle positivo da sonda", () => {
    // Sem este caso, o defeito que este PR teve (migration 0769 sem apêndice no
    // banco-molde) devolveria NENHUM para todo mundo e os casos de privilégio
    // passariam por acidente, afirmando segurança sobre uma tabela que o kit
    // self-host nem cria.
    const existe = sql(`
      select count(*) from information_schema.tables
       where table_schema = 'public' and table_name = 'organization_resend_accounts';
    `);
    expect(existe, "`organization_resend_accounts` não está no baseline — o kit self-host não a cria").toBe("1");
  });

  it("a RLS está LIGADA — o segundo degrau, para o dia em que o grant voltar", () => {
    const ligada = sql(`
      select relrowsecurity from pg_class where oid = 'public.organization_resend_accounts'::regclass;
    `);
    expect(ligada, "RLS desligada: o revoke vira a única defesa").toBe("t");
  });

  it("não há policy nenhuma — servir esta tabela nunca foi a intenção", () => {
    const quantas = sql(`
      select count(*) from pg_policies
       where schemaname = 'public' and tablename = 'organization_resend_accounts';
    `);
    expect(
      quantas,
      "alguém criou policy: a tabela passa a ser SERVIDA pelo PostgREST, e a chave " +
        "fica atrás de uma regra em vez de atrás da ausência de privilégio",
    ).toBe("0");
  });

  it("`anon` e `authenticated` não têm privilégio NENHUM — o revoke da 0769 é a primeira defesa", () => {
    // É a defesa que vale contra o ALTER DEFAULT PRIVILEGES do baseline: sem o
    // revoke, a tabela nasce concedida aos dois papéis de navegador.
    const semPrivilegio = sql(`
      select bool_and(not has_table_privilege(r, 'public.organization_resend_accounts', o))
        from unnest(array['anon', 'authenticated']) r
       cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) o;
    `);
    expect(semPrivilegio, "anon/authenticated têm privilégio na tabela da chave").toBe("t");
  });

  it("`service_role` CONTINUA com privilégio — o papel que o worker e as actions usam", () => {
    // Se ele sumir, a action de conexão e o envio param de funcionar e a
    // tela degrada em silêncio, sem ninguém entender por quê.
    expect(sql(`select has_table_privilege('service_role', 'public.organization_resend_accounts', 'SELECT');`)).toBe("t");
  });

  it("nenhuma view (nem materializada) expõe a tabela — o last4 não vaza por uma porta dos fundos", () => {
    // O desenho certo é a action ler o last4 com o admin client. Uma view
    // security_invoker criada "só para a tela" seria uma segunda porta que
    // este teste não veria no resto — fechada aqui, de uma vez.
    const portas = sql(`
      select (select count(*) from pg_views
               where schemaname = 'public' and definition like '%organization_resend_accounts%')
           + (select count(*) from pg_matviews
               where schemaname = 'public' and definition like '%organization_resend_accounts%');
    `);
    expect(portas, "uma view expõe organization_resend_accounts — o last4 ganhou uma segunda porta").toBe("0");
  });

  it("o segredo gravado é CIFRA: bytea, e o único texto da chave é o last4 de 4 caracteres", () => {
    // O contrato da GRAVAÇÃO. As três colunas do envelope são bytea opaco (não
    // há como serializá-las como texto legível num payload JSON), e o last4 é
    // o único lugar onde a chave aparece em derivação textual — com 4
    // caracteres, não a chave inteira com outro nome.
    const colunas = sql(`
      select string_agg(column_name || ':' || data_type, ',' order by column_name)
        from information_schema.columns
       where table_schema = 'public' and table_name = 'organization_resend_accounts'
         and column_name in ('api_key_ciphertext', 'api_key_iv', 'api_key_tag', 'api_key_last4');
    `);
    expect(colunas).toBe(
      "api_key_ciphertext:bytea,api_key_iv:bytea,api_key_last4:text,api_key_tag:bytea",
    );

    // E a linha semeada obedece o contrato: last4 de exatamente 4, e a chave
    // CRUA não aparece em nenhuma das três colunas do envelope.
    expect(
      sql(`select length(api_key_last4) from public.organization_resend_accounts where organization_id = '${ORG_A}';`),
    ).toBe("4");
    expect(
      sql(`
        select bool_and(
                 position(convert_to('${CHAVE_CRUA}', 'UTF8') in coalesce(api_key_ciphertext, ''::bytea)) = 0
             and position(convert_to('${CHAVE_CRUA}', 'UTF8') in coalesce(api_key_iv, ''::bytea)) = 0
             and position(convert_to('${CHAVE_CRUA}', 'UTF8') in coalesce(api_key_tag, ''::bytea)) = 0)
          from public.organization_resend_accounts
         where organization_id = '${ORG_A}';
      `),
      "a chave em claro aparece em alguma coluna do envelope — a cifra virou decoração",
    ).toBe("t");
  });
});

describe("a linha semeada numa organização não é lida por authenticated nem por anon", () => {
  it("controle positivo: o banco tem EXATAMENTE a linha da organização dona", () => {
    // Sem a linha, os casos de "não lê" passariam por vacuidade — afirmando
    // isolamento sobre nada. O servidor (superusuário) a lê: 1 da dona, 0 da
    // vizinha, 1 no total.
    expect(sql(`select count(*) from public.organization_resend_accounts;`)).toBe("1");
    expect(
      sql(`select count(*) from public.organization_resend_accounts where organization_id = '${ORG_A}';`),
    ).toBe("1");
    expect(
      sql(`select count(*) from public.organization_resend_accounts where organization_id = '${ORG_B}';`),
    ).toBe("0");
  });

  it("membro da PRÓPRIA organização com JWT authenticated é BARRADO — permission denied, não zero linhas", () => {
    // Este é o caso forte do molde lgpd-marca-de-apagamento: nem o membro da
    // organização dona alcança a chave pelo client de sessão. A distinção
    // importa — "zero linhas" diria que a policy filtrou; "permission denied"
    // diz que o privilégio nem existe, que é a postura desejada.
    expect(() =>
      sql(`
        set role authenticated;
        select set_config('request.jwt.claims', '{"sub":"${MEMBRO_A}"}', false);
        select count(*) from public.organization_resend_accounts;
      `),
    ).toThrow(/permission denied/);
  });

  it("`anon` também é BARRADO ao ler", () => {
    expect(() =>
      sql(`
        set role anon;
        select count(*) from public.organization_resend_accounts;
      `),
    ).toThrow(/permission denied/);
  });

  it("a chave cifrada NUNCA sai em payload: authenticated é barrado até em `api_key_last4`", () => {
    // O contrato da tela é o SERVER ler o last4 com o admin client
    // (`estadoDaContaResend`) e devolver SÓ ele; o client de sessão não recebe
    // nada — nem a cifra, nem os 4 últimos. Se alguém abrir policy "só para a
    // tela mostrar o last4", este caso reprova: a porta certa é a action, não
    // a policy.
    for (const coluna of ["api_key_last4", "api_key_ciphertext"]) {
      expect(() =>
        sql(`
          set role authenticated;
          select set_config('request.jwt.claims', '{"sub":"${MEMBRO_A}"}', false);
          select ${coluna} from public.organization_resend_accounts;
        `),
        `${coluna} saiu num payload para authenticated`,
      ).toThrow(/permission denied/);
    }
  });

  it("escrita direta por authenticated é barrada — o upsert é do servidor", () => {
    // A action de conexão faz `upsert` com o admin client. Escrita direta pelo
    // client de sessão seria a porta para qualquer membro trocar a chave da
    // conta de e-mail da organização inteira.
    expect(() =>
      sql(`
        set role authenticated;
        select set_config('request.jwt.claims', '{"sub":"${MEMBRO_A}"}', false);
        insert into public.organization_resend_accounts
            (organization_id, api_key_ciphertext, api_key_iv, api_key_tag, api_key_last4, from_email)
          values ('${ORG_B}', '\\x00'::bytea, '\\x00'::bytea, '\\x00'::bytea, 'vazou', 'vazou@invariant.test');
      `),
    ).toThrow(/permission denied/);
  });

  it("service_role tem somente os quatro privilégios CRUD explícitos", () => {
    const acl = sql(`
      select string_agg(a.privilege_type, ',' order by a.privilege_type)
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      cross join lateral aclexplode(c.relacl) a
      join pg_roles r on r.oid = a.grantee
      where n.nspname = 'public' and c.relname = 'organization_resend_accounts'
        and r.rolname = 'service_role';
    `);
    expect(acl).toBe("DELETE,INSERT,SELECT,UPDATE");
  });

  it("não há grant direto para PUBLIC, anon ou authenticated, de qualquer privilégio", () => {
    expect(sql(`
      select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
      cross join lateral aclexplode(c.relacl) a
      left join pg_roles r on r.oid = a.grantee
      where n.nspname = 'public' and c.relname = 'organization_resend_accounts'
        and (a.grantee = 0 or r.rolname in ('anon', 'authenticated'));
    `)).toBe("0");
    // Privilégio efetivo inclui herança e PUBLIC: sete do piso pg15, com
    // TRUNCATE (sem RLS), REFERENCES e TRIGGER; MAINTAIN existe desde pg17.
    expect(sql(`
      select bool_and(not has_table_privilege(r, 'public.organization_resend_accounts', o))
        from unnest(array['anon', 'authenticated']) r
       cross join unnest(
         array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']
         || case when current_setting('server_version_num')::int >= 170000
              then array['MAINTAIN'] else array[]::text[] end
       ) o;
    `)).toBe("t");
  });

  it("service_role insere, lê, atualiza e apaga a conta sem ganhar TRUNCATE", () => {
    sql(`set role service_role;
      insert into public.organization_resend_accounts
        (organization_id,api_key_ciphertext,api_key_iv,api_key_tag,api_key_last4,from_email)
      values ('${ORG_B}',decode('00','hex'),decode('00','hex'),decode('00','hex'),'crud','crud@invariant.test');
    `);
    expect(sql(`set role service_role; select from_email from public.organization_resend_accounts where organization_id='${ORG_B}';`).split('\n').at(-1)).toBe("crud@invariant.test");
    sql(`set role service_role; update public.organization_resend_accounts set from_email='atualizado@invariant.test' where organization_id='${ORG_B}';`);
    expect(sql(`set role service_role; select from_email from public.organization_resend_accounts where organization_id='${ORG_B}';`).split('\n').at(-1)).toBe("atualizado@invariant.test");
    sql(`set role service_role; delete from public.organization_resend_accounts where organization_id='${ORG_B}';`);
    expect(sql(`set role service_role; select count(*) from public.organization_resend_accounts where organization_id='${ORG_B}';`).split('\n').at(-1)).toBe("0");
    expect(sql(`select has_table_privilege('service_role','public.organization_resend_accounts','TRUNCATE');`)).toBe("f");
  });
});
