import { beforeAll, describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

/**
 * Migration 0757 — o poder de PLATAFORMA (`fn_is_platform_admin_full`, o ramo
 * `scope = 'full'` das policies de escrita) pede o código provado NESTA sessão
 * (`aal2`) de quem tem fator verificado. É a régua da 0747 na anonimização e de
 * `mfaEmDividaEstrita` no app, agora no banco inteiro.
 *
 * O que NÃO pode mudar: sem fator cadastrado (a verificação é opcional e vem
 * desligada) o admin da plataforma escreve como antes; e quem escreve pelo
 * PAPEL na própria organização — admin de plataforma ou membro comum — segue
 * como estava, porque ali quem autoriza é `fn_user_org_ids` / `fn_role_at_least`.
 */
const PLAT = "dddddddd-0757-4000-8000-000000000001";
const PLAT_SEM_FATOR = "dddddddd-0757-4000-8000-000000000002";
const MEMBRO = "dddddddd-0757-4000-8000-000000000003";
const FATOR_PLAT = "dddddddd-0757-4000-8000-0000000000f1";
const FATOR_MEMBRO = "dddddddd-0757-4000-8000-0000000000f3";
const SESSAO = "dddddddd-0757-4000-8000-0000000000a1";
const PROPRIA = "dddddddd-0757-4000-8000-0000000000b1";
const OUTRA = "dddddddd-0757-4000-8000-0000000000b2";

type Aal = "aal1" | "aal2";

/**
 * Roda `corpo` como `usuario`, numa transação desfeita no fim, e devolve a linha
 * marcada com `R:`. Erro do banco (RLS recusando um INSERT) vira exceção.
 */
function como(usuario: string, aal: Aal, corpo: string): string | undefined {
  const claims = JSON.stringify({ sub: usuario, session_id: SESSAO, aal, role: "authenticated" });
  return sql(`
    begin;
    set local role authenticated;
    select set_config('request.jwt.claims', '${claims}', true);
    ${corpo}
    rollback;
  `)
    .split("\n")
    .find((l) => l.startsWith("R:"))
    ?.slice(2);
}

/** INSERT em `user_organizations` (`user_orgs_insert`). */
const filiar = (usuario: string, aal: Aal, org: string) =>
  como(
    usuario,
    aal,
    `insert into public.user_organizations (user_id, organization_id, role, accepted_at)
       values ('${usuario}', '${org}', 'admin', now());
     select 'R:ok';`,
  );

/** UPDATE em `organizations` (`orgs_write_platform_admin`): quantas linhas mudaram. */
const renomear = (usuario: string, aal: Aal, org: string) =>
  como(
    usuario,
    aal,
    `with u as (update public.organizations set display_name = 'Renomeada 0757' where id = '${org}' returning 1)
     select 'R:' || count(*) from u;`,
  );

/** INSERT em `contacts` (`tenant_isolation_contacts_write`). */
const criarContato = (usuario: string, aal: Aal, org: string) =>
  como(
    usuario,
    aal,
    `insert into public.contacts (organization_id, name, display_name) values ('${org}', 'Contato 0757', 'Contato 0757');
     select 'R:ok';`,
  );

function confiar(on: boolean) {
  sql(`
    delete from public.mfa_trusted_devices where user_id = '${PLAT}';
    ${
      on
        ? `insert into public.mfa_trusted_devices (user_id, factor_id, token_hash, session_id, expires_at)
           values ('${PLAT}', '${FATOR_PLAT}', md5(random()::text), '${SESSAO}', now() + interval '30 days');`
        : ""
    }
  `);
}

const RLS = /row-level security/;

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${PLAT}', 'plataforma-0757@example.test'),
      ('${PLAT_SEM_FATOR}', 'plataforma-sem-fator-0757@example.test'),
      ('${MEMBRO}', 'membro-0757@example.test')
    on conflict (id) do nothing;
    insert into auth.mfa_factors (id, user_id, status, factor_type) values
      ('${FATOR_PLAT}', '${PLAT}', 'verified', 'totp'),
      ('${FATOR_MEMBRO}', '${MEMBRO}', 'verified', 'totp')
    on conflict (id) do nothing;
    insert into public.platform_admins (user_id, granted_by, scope, mfa_required, reason) values
      ('${PLAT}', '${PLAT}', 'full', false, 'invariante 0757'),
      ('${PLAT_SEM_FATOR}', '${PLAT_SEM_FATOR}', 'full', false, 'invariante 0757')
    on conflict do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${PROPRIA}', 'propria-0757', 'Própria 0757', 'Própria 0757'),
      ('${OUTRA}', 'outra-0757', 'Outra 0757', 'Outra 0757')
    on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${PLAT}', '${PROPRIA}', 'admin', now()),
      ('${MEMBRO}', '${PROPRIA}', 'admin', now())
    on conflict do nothing;
  `);
});

describe("0757 — com fator e sem o código nesta sessão, o ramo de plataforma não vale", () => {
  it("user_orgs_insert", () => {
    confiar(false);
    expect(() => filiar(PLAT, "aal1", OUTRA)).toThrow(RLS);
  });

  it("orgs_write_platform_admin", () => {
    expect(renomear(PLAT, "aal1", OUTRA)).toBe("0");
  });

  it("tenant_isolation_contacts_write", () => {
    expect(() => criarContato(PLAT, "aal1", OUTRA)).toThrow(RLS);
  });

  it("dispositivo confiável não substitui o código no ramo de plataforma", () => {
    confiar(true);
    try {
      expect(() => filiar(PLAT, "aal1", OUTRA)).toThrow(RLS);
      expect(renomear(PLAT, "aal1", OUTRA)).toBe("0");
      expect(() => criarContato(PLAT, "aal1", OUTRA)).toThrow(RLS);
    } finally {
      confiar(false);
    }
  });
});

describe("0757 — com o código provado nesta sessão, o ramo de plataforma vale", () => {
  it("user_orgs_insert", () => {
    expect(filiar(PLAT, "aal2", OUTRA)).toBe("ok");
  });

  it("orgs_write_platform_admin", () => {
    expect(renomear(PLAT, "aal2", OUTRA)).toBe("1");
  });

  it("tenant_isolation_contacts_write", () => {
    expect(criarContato(PLAT, "aal2", OUTRA)).toBe("ok");
  });
});

describe("0757 — o que não muda", () => {
  it("admin da plataforma SEM fator cadastrado (verificação opcional) escreve como antes", () => {
    expect(filiar(PLAT_SEM_FATOR, "aal1", OUTRA)).toBe("ok");
    expect(renomear(PLAT_SEM_FATOR, "aal1", OUTRA)).toBe("1");
    expect(criarContato(PLAT_SEM_FATOR, "aal1", OUTRA)).toBe("ok");
  });

  it("admin da plataforma COM fator segue escrevendo pelo papel na própria organização", () => {
    expect(criarContato(PLAT, "aal1", PROPRIA)).toBe("ok");
  });

  it("membro comum com fator escreve na própria organização como antes", () => {
    expect(criarContato(MEMBRO, "aal1", PROPRIA)).toBe("ok");
    expect(criarContato(MEMBRO, "aal2", PROPRIA)).toBe("ok");
  });

  it("CONTROLE: membro comum não escreve em outra organização, com ou sem o código", () => {
    for (const aal of ["aal1", "aal2"] as const) {
      expect(() => filiar(MEMBRO, aal, OUTRA)).toThrow(RLS);
      expect(renomear(MEMBRO, aal, OUTRA)).toBe("0");
      expect(() => criarContato(MEMBRO, aal, OUTRA)).toThrow(RLS);
    }
  });
});
