/**
 * O CPF DO CONTATO, NO BANCO DE VERDADE — migration 0597 (#2522).
 *
 * Os testes de `tests/unit/cpf-cifra-nasce-no-schema.test.ts` leem o TEXTO da
 * migration e do apêndice. Este arquivo roda as funções: a cifra existe, a linha
 * com os dois campos entra, a decifra devolve o mesmo CPF, deixa rastro no
 * audit, e recusa quem não deve ler — outra organização e quem está abaixo de
 * `manager` (a mesma régua de `getContactHandler`, que só decifra para manager+).
 */
import { beforeAll, describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

const ORG = "05910000-0000-4000-8000-000000000001";
const OUTRA_ORG = "05910000-0000-4000-8000-000000000002";
const GERENTE = "05910000-5555-4000-8000-000000000001";
const ESPECTADOR = "05910000-5555-4000-8000-000000000002";
const ESTRANHO = "05910000-5555-4000-8000-000000000003";
const CONTATO = "05910000-3333-4000-8000-000000000001";
const CPF = "52998224725";

function ultima(saida: string): string {
  return (saida.trim().split("\n").at(-1) ?? "").trim();
}

function comoUsuario(usuario: string, consulta: string): string {
  return sql(`set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${usuario}","role":"authenticated"}', false);
    ${consulta}`);
}

function erroDe(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return motivoDoErro(err);
  }
  return "";
}

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${GERENTE}', 'cpf-0597-gerente@invariant.test'),
      ('${ESPECTADOR}', 'cpf-0597-viewer@invariant.test'),
      ('${ESTRANHO}', 'cpf-0597-estranho@invariant.test')
      on conflict do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG}', 'cpf-0597', 'Cpf 0597', 'Cpf 0597'),
      ('${OUTRA_ORG}', 'cpf-0597-b', 'Cpf 0597 B', 'Cpf 0597 B')
      on conflict do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${GERENTE}', '${ORG}', 'manager', now()),
      ('${ESPECTADOR}', '${ORG}', 'viewer', now()),
      ('${ESTRANHO}', '${OUTRA_ORG}', 'admin', now())
      on conflict do nothing;
  `);
});

describe("a cifra do CPF existe e roda (#2522)", () => {
  it("encrypt_cpf e decrypt_cpf existem no schema", () => {
    expect(ultima(sql(`select to_regprocedure('public.encrypt_cpf(text)') is not null
      and to_regprocedure('public.decrypt_cpf(uuid)') is not null;`))).toBe("t");
  });

  it("a linha com SÓ cpf_hash é recusada pelo CHECK — o defeito que a issue relata", () => {
    const erro = erroDe(() => sql(`insert into public.contacts (organization_id, name, cpf_hash)
      values ('${ORG}', 'So hash', 'abc');`));
    expect(erro).toContain("contacts_cpf_consistency");
  });

  it("sem a chave semeada, encrypt_cpf recusa com a mensagem conhecida", () => {
    sql(`delete from private.app_secrets where name = 'cpf_key';`);
    expect(erroDe(() => sql(`select public.encrypt_cpf('${CPF}');`))).toContain("CPF_ENCRYPTION_KEY ausente");
  });

  it("com a chave, a linha nasce com os dois campos e o gerente lê o MESMO CPF, com audit", () => {
    sql(`insert into private.app_secrets (name, value) values ('cpf_key', repeat('k', 44))
           on conflict (name) do update set value = excluded.value;
         insert into public.contacts (id, organization_id, name, cpf_hash, cpf_encrypted)
           values ('${CONTATO}', '${ORG}', 'Com CPF', 'hash-0597', public.encrypt_cpf('${CPF}'))
           on conflict (id) do nothing;`);
    expect(ultima(comoUsuario(GERENTE, `select public.decrypt_cpf('${CONTATO}');`))).toBe(CPF);
    expect(ultima(sql(`select count(*) from public.api_audit_log
      where action = 'contact.cpf_decrypted' and resource_id = '${CONTATO}'
        and actor_user_id = '${GERENTE}';`))).toBe("1");
  });

  it("membro de OUTRA organização não decifra", () => {
    expect(erroDe(() => comoUsuario(ESTRANHO, `select public.decrypt_cpf('${CONTATO}');`)))
      .toContain("forbidden");
  });

  it("viewer da MESMA organização não decifra — a régua de getContactHandler é manager+", () => {
    const erro = erroDe(() => comoUsuario(ESPECTADOR, `select public.decrypt_cpf('${CONTATO}');`));
    expect(erro, "o viewer decifrou o CPF").toContain("forbidden");
  });
});
