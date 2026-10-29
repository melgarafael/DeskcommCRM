/**
 * O AVISO ESCRITO PELO ADMIN É SERVER-SIDE ONLY — E ISSO SE MEDE (migration 9043).
 *
 * `public.avisos` guarda o recado que o admin da empresa escreve para empurrar
 * como push para o time inteiro (#1418, fatia 1). Não é dado pessoal, mas é
 * CONTEÚDO EM NOME DO CLIENTE: quem lê a tabela pelo PostgREST com a anon key +
 * um JWT qualquer leva embora o texto que ainda não foi publicado e o rascunho
 * de outro tenant. Por isso a postura é a mesma de `map_provider_credentials`
 * (0504) e das tabelas de anúncios (0213): RLS ligada, ZERO policy alcançável
 * por anon/authenticated, privilégio nenhum, escrita e leitura só pelo
 * service_role — que é quem a rota `app/api/v1/admin/avisos` usa.
 *
 * Esta é a prova comportamental que a varredura de completude
 * (`tests/invariants/rls-completude-varredura.test.ts`) cobra de toda tabela
 * nova com `organization_id`: a tabela está declarada lá em `PROVA_PROPRIA`,
 * citando este arquivo. Ela NÃO entra em `TABLES` do rls-isolation de propósito:
 * lá o controle positivo é "o usuário da própria organização lê ≥ 1 linha", e
 * aqui `authenticated` não tem privilégio NENHUM — o caso ficaria vermelho, e a
 * "correção" natural seria criar uma policy, isto é, passar a SERVIR pelo
 * PostgREST justamente a tabela que só o servidor escreve.
 *
 * Por que contar linhas não bastaria: com RLS ligada e sem policy, `anon` já
 * recebe zero linhas MESMO com o grant de volta. O que se mede aqui é
 * privilégio (catálogo) e comportamento (`permission denied` sob `set role`).
 */
import { describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

const TABELA = "avisos";

function erroSob(papel: string, comando: string): string | null {
  try {
    sql(`set role ${papel};\n${comando};\nreset role;`);
    return null;
  } catch (err) {
    return motivoDoErro(err);
  }
}

function privilegiosDe(papel: string): string {
  return sql(`
    select coalesce(string_agg(distinct privilege_type, ',' order by privilege_type), 'NENHUM')
      from information_schema.role_table_grants
     where table_schema = 'public' and table_name = '${TABELA}' and grantee = '${papel}';
  `).trim();
}

describe("o PostgREST não serve o aviso escrito pelo admin", () => {
  it("a tabela EXISTE no baseline — controle positivo da sonda", () => {
    // Sem esta guarda, um baseline em que o bloco da 9043 não chegou faria os
    // `count(*)` abaixo devolverem 0 e o arquivo inteiro passar por AUSÊNCIA.
    const existe = sql(`
      select count(*) from information_schema.tables
       where table_schema = 'public' and table_name = '${TABELA}';
    `).trim();
    expect(existe, "a 9043 não chegou ao baseline — o kit self-host não cria a tabela").toBe("1");
  });

  it("`anon` e `authenticated` não têm privilégio NENHUM", () => {
    expect(privilegiosDe("anon")).toBe("NENHUM");
    expect(privilegiosDe("authenticated")).toBe("NENHUM");
  });

  it("`service_role` CONTINUA com privilégio — controle positivo do papel que usa", () => {
    const p = privilegiosDe("service_role");
    for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE"]) expect(p).toContain(priv);
  });

  it("LIGAR sob `anon` e sob `authenticated` é BARRADO — permission denied, não zero linhas", () => {
    for (const papel of ["anon", "authenticated"]) {
      const erro = erroSob(papel, `select titulo, corpo from public.${TABELA}`);
      expect(erro, `\`${papel}\` leu a tabela SEM erro — o rascunho do cliente está exposto`).not.toBeNull();
      expect(erro).toContain("permission denied");
    }
  });

  it("ESCREVER sob `anon` e sob `authenticated` é BARRADO nos três verbos", () => {
    // O caminho de escrita é o pior dos dois: um aviso forjado com o JWT de
    // qualquer pessoa da instalação viraria push de "manutenção" no celular do
    // time de outra empresa. `insert`/`update`/`delete` são medidos um a um
    // porque um grant parcial (só INSERT, por exemplo) é o erro plausível.
    const comandos = [
      `insert into public.${TABELA} (organization_id, titulo, corpo) values (gen_random_uuid(), 'x', 'y')`,
      `update public.${TABELA} set titulo = 'x'`,
      `delete from public.${TABELA}`,
    ];
    for (const papel of ["anon", "authenticated"]) {
      for (const comando of comandos) {
        const erro = erroSob(papel, comando);
        expect(erro, `\`${papel}\` executou \`${comando}\` SEM erro`).not.toBeNull();
        expect(erro).toContain("permission denied");
      }
    }
  });

  it("RLS ligada e nenhuma policy ALCANÇÁVEL por anon/authenticated", () => {
    expect(sql(`select relrowsecurity from pg_class where oid = 'public.${TABELA}'::regclass;`).trim()).toBe("t");
    // Não é `count(*) = 0`: a varredura `fn_aplicar_travas_de_suporte()` (0274)
    // pode deixar policies RESTRITIVAS nesta tabela, e restritiva só AND-a com
    // permissiva — não concede nada. O contrato que se mede é "nenhuma policy
    // que valha para anon/authenticated", que é o que abriria o PostgREST.
    const alcancaveis = sql(`
      select coalesce(string_agg(policyname || ' (' || roles::text || ')', ', '), 'NENHUMA')
        from pg_policies
       where schemaname = 'public' and tablename = '${TABELA}'
         and roles && array['public', 'anon', 'authenticated']::name[];
    `).trim();
    expect(alcancaveis, "policy alcançável por anon/authenticated serve a tabela pelo PostgREST").toBe(
      "NENHUMA",
    );
  });

  it("`organization_id` NOT NULL com FK em cascata, e `autor_id` que sobrevive ao autor", () => {
    expect(
      sql(`
        select is_nullable from information_schema.columns
         where table_schema = 'public' and table_name = '${TABELA}' and column_name = 'organization_id';
      `).trim(),
      "aviso sem organização não teria dono e escaparia da varredura de tenant",
    ).toBe("NO");
    expect(
      sql(`
        select confdeltype from pg_constraint
         where conrelid = 'public.${TABELA}'::regclass and contype = 'f'
           and confrelid = 'public.organizations'::regclass;
      `).trim(),
      "apagar a organização tem de levar os avisos dela junto",
    ).toBe("c");
    // `set null`, não `cascade`: o aviso continua valendo depois que o admin que
    // o escreveu sai da empresa — o que caduca é o autor, não o recado.
    expect(
      sql(`
        select confdeltype from pg_constraint
         where conrelid = 'public.${TABELA}'::regclass and contype = 'f'
           and confrelid = 'auth.users'::regclass;
      `).trim(),
      "apagar o autor não pode apagar o aviso que já foi para o time",
    ).toBe("n");
  });

  it("o apêndice do baseline ESPELHA a migration: o índice (organização, publicação) existe", () => {
    // A leitura do caminho quente é "publicados desta organização, mais recentes
    // primeiro". Sem o índice no baseline, a instalação nova nasce sem ele e a
    // atualização fica com ele — mesma divergência que `update.sh` existe para
    // evitar.
    expect(
      sql(`
        select count(*) from pg_indexes
         where schemaname = 'public' and tablename = '${TABELA}'
           and indexname = 'avisos_org_publicar_idx';
      `).trim(),
    ).toBe("1");
  });
});
