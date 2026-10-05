/**
 * A CHAVE DE MAPAS É SERVER-SIDE ONLY — E ISSO SE MEDE (migration 0504).
 *
 * `map_provider_credentials` guarda a chave do Google da organização. A anon
 * key vai para o browser; se o PostgREST servisse esta tabela, qualquer um com
 * a página aberta leria a chave cifrada — e a chave em claro sai por
 * `fn_decrypt_oauth`, que é do service_role, mas cifra lida é meio caminho.
 *
 * Mesmo desenho e mesma régua de `credencial-de-anuncios-e-server-side.test.ts`:
 * RLS ligada, zero policies, grants revogados — e aqui se mede PRIVILÉGIO e
 * COMPORTAMENTO (`permission denied`), porque com RLS sem policy `anon` já
 * receberia zero linhas mesmo com o grant de volta, e contar linhas não veria.
 * Não entra em `TABLES` do rls-isolation pelo mesmo motivo de lá.
 */
import { describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

const TABELA = "map_provider_credentials";

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

describe("o PostgREST não serve a chave de mapas", () => {
  it("a tabela EXISTE no baseline — controle positivo da sonda", () => {
    const existe = sql(`
      select count(*) from information_schema.tables where table_schema = 'public' and table_name = '${TABELA}';
    `).trim();
    expect(existe, "a 0504 não chegou ao baseline — o kit self-host não cria a tabela").toBe("1");
  });

  it("`anon` e `authenticated` não têm privilégio NENHUM", () => {
    expect(privilegiosDe("anon")).toBe("NENHUM");
    expect(privilegiosDe("authenticated")).toBe("NENHUM");
  });

  it("`service_role` CONTINUA com privilégio — controle positivo do papel que usa", () => {
    const p = privilegiosDe("service_role");
    for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE"]) expect(p).toContain(priv);
  });

  it("ler sob `anon` e sob `authenticated` é BARRADO — permission denied, não zero linhas", () => {
    for (const papel of ["anon", "authenticated"]) {
      const erro = erroSob(papel, `select api_key_encrypted from public.${TABELA}`);
      expect(erro, `\`${papel}\` leu a tabela SEM erro — a chave está exposta`).not.toBeNull();
      expect(erro).toContain("permission denied");
    }
  });

  it("RLS ligada e nenhuma policy", () => {
    expect(sql(`select relrowsecurity from pg_class where oid = 'public.${TABELA}'::regclass;`).trim()).toBe("t");
    expect(sql(`select count(*) from pg_policies where schemaname = 'public' and tablename = '${TABELA}';`).trim()).toBe("0");
  });

  it("`organization_id` NOT NULL com FK em cascata, e uma chave por provedor por organização", () => {
    expect(
      sql(`
        select is_nullable from information_schema.columns
         where table_schema = 'public' and table_name = '${TABELA}' and column_name = 'organization_id';
      `).trim(),
    ).toBe("NO");
    expect(
      sql(`
        select confdeltype from pg_constraint
         where conrelid = 'public.${TABELA}'::regclass and contype = 'f'
           and confrelid = 'public.organizations'::regclass;
      `).trim(),
    ).toBe("c");
    expect(
      sql(`
        select count(*) from pg_indexes
         where schemaname = 'public' and tablename = '${TABELA}'
           and indexdef ilike '%unique%(organization_id, provider)%';
      `).trim(),
    ).toBe("1");
  });
});
