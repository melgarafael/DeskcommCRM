import { beforeAll, describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

/**
 * Migration 0762 — decifrar o CPF (`decrypt_cpf`) pelo poder de PLATAFORMA, fora
 * do papel na organização do contato, segue a régua da `fn_is_platform_admin_full`
 * (0757): `scope = 'full'` e, para quem tem fator verificado, o código provado
 * NESTA sessão (`aal2`). Sem fator cadastrado nada muda.
 *
 * O que NÃO pode mudar: o membro manager+ da organização do contato lê como
 * antes — ali quem autoriza é o papel, e o fator dele não entra na conta.
 */
const PLAT = "dddddddd-0762-4000-8000-000000000001";
const PLAT_SEM_FATOR = "dddddddd-0762-4000-8000-000000000002";
const SUPORTE = "dddddddd-0762-4000-8000-000000000003";
const MEMBRO = "dddddddd-0762-4000-8000-000000000004";
const FATOR_PLAT = "dddddddd-0762-4000-8000-0000000000f1";
const FATOR_MEMBRO = "dddddddd-0762-4000-8000-0000000000f4";
const SESSAO = "dddddddd-0762-4000-8000-0000000000a1";
const ORG = "dddddddd-0762-4000-8000-0000000000b1";
const CONTATO = "dddddddd-0762-4000-8000-0000000000c1";
const CPF = "39053344705";

type Aal = "aal1" | "aal2";

/** `decrypt_cpf` como `usuario`, numa transação desfeita; erro do banco vira exceção. */
function decifrar(usuario: string, aal: Aal): string | undefined {
  const claims = JSON.stringify({ sub: usuario, session_id: SESSAO, aal, role: "authenticated" });
  return sql(`
    begin;
    set local role authenticated;
    select set_config('request.jwt.claims', '${claims}', true);
    select 'R:' || public.decrypt_cpf('${CONTATO}');
    rollback;
  `)
    .split("\n")
    .find((l) => l.startsWith("R:"))
    ?.slice(2);
}

const RECUSA = /forbidden_org|forbidden_role/;

beforeAll(() => {
  sql(`
    insert into private.app_secrets (name, value) values ('cpf_key', repeat('k', 44))
      on conflict (name) do update set value = excluded.value;
    insert into auth.users (id, email) values
      ('${PLAT}', 'plataforma-0762@invariant.test'),
      ('${PLAT_SEM_FATOR}', 'plataforma-sem-fator-0762@invariant.test'),
      ('${SUPORTE}', 'suporte-0762@invariant.test'),
      ('${MEMBRO}', 'membro-0762@invariant.test')
    on conflict (id) do nothing;
    insert into auth.mfa_factors (id, user_id, status, factor_type) values
      ('${FATOR_PLAT}', '${PLAT}', 'verified', 'totp'),
      ('${FATOR_MEMBRO}', '${MEMBRO}', 'verified', 'totp')
    on conflict (id) do nothing;
    insert into public.platform_admins (user_id, granted_by, scope, mfa_required, reason) values
      ('${PLAT}', '${PLAT}', 'full', false, 'invariante 0762'),
      ('${PLAT_SEM_FATOR}', '${PLAT_SEM_FATOR}', 'full', false, 'invariante 0762'),
      ('${SUPORTE}', '${SUPORTE}', 'support_readonly', false, 'invariante 0762')
    on conflict do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG}', 'cpf-0762', 'Cpf 0762', 'Cpf 0762')
    on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${MEMBRO}', '${ORG}', 'manager', now())
    on conflict do nothing;
    insert into public.contacts (id, organization_id, name, cpf_hash, cpf_encrypted)
      values ('${CONTATO}', '${ORG}', 'Com CPF 0762', 'hash-0762', public.encrypt_cpf('${CPF}'))
    on conflict (id) do nothing;
  `);
});

describe("0762 — o ramo de plataforma de decrypt_cpf pede scope full e a sessão confirmada", () => {
  it("admin de plataforma support_readonly não decifra, nem com aal2", () => {
    expect(() => decifrar(SUPORTE, "aal2")).toThrow(RECUSA);
  });

  it("admin de plataforma full com fator e sessão aal1 não decifra", () => {
    expect(() => decifrar(PLAT, "aal1")).toThrow(RECUSA);
  });

  it("admin de plataforma full com fator e sessão aal2 decifra", () => {
    expect(decifrar(PLAT, "aal2")).toBe(CPF);
  });

  it("admin de plataforma full sem fator cadastrado decifra como antes", () => {
    expect(decifrar(PLAT_SEM_FATOR, "aal1")).toBe(CPF);
  });
});

describe("0762 — o membro da organização do contato segue como estava", () => {
  it("manager com fator verificado e sessão aal1 decifra", () => {
    expect(decifrar(MEMBRO, "aal1")).toBe(CPF);
  });
});
