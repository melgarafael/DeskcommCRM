/**
 * O PROPÓSITO DA LEITURA DO CPF SAI NA LINHA CERTA DA TRILHA — migration 9423 (#4892).
 *
 * ─── O defeito que a issue mediu ─────────────────────────────────────────────
 *
 * `decrypt_cpf` audita `contact.cpf_decrypted` lendo o GUC `app.decrypt_purpose`.
 * O handler da ficha chama a RPC pelo PostgREST, que abre a TRANSAÇÃO dele: não
 * há como fixar o GUC na mesma transação, então a linha do decrypt nascia com
 * `metadata.purpose = null`. O propósito ia parar numa SEGUNDA linha —
 * `contact.updated` —, que anuncia atualização de ficha para um evento de
 * LEITURA; quem audita LGPD filtrando por `contact.cpf_decrypted` não achava o
 * motivo.
 *
 * ─── O que este arquivo prova, com Postgres de verdade ───────────────────────
 *
 * 1. as DUAS assinaturas existem (`decrypt_cpf(uuid)` e `decrypt_cpf(uuid,text)`);
 * 2. o propósito passado como PARÂMETRO chega à linha `contact.cpf_decrypted`;
 * 3. o parâmetro VENCE o GUC, e o GUC continua valendo quando o parâmetro é nulo
 *    — é o `coalesce(p_purpose, current_setting(...))` do corpo auditado;
 * 4. a chamada de UM argumento (a casca) continua devolvendo o CPF e auditando
 *    com o GUC, ou `null` quando o GUC não foi setado (o contrato da 0597);
 * 5. a leitura NÃO grava `contact.updated` (contagem 0 para o contato);
 * 6. as guardas de tenancy e de papel continuam nas duas portas — a assinatura
 *    nova não é atalho para viewer nem para outra organização.
 *
 * O caso 3 (`decrypt_cpf(id, null)` com GUC setado) é o que fica VERMELHO se
 * alguém trocar o `coalesce(p_purpose, ...)` por `p_purpose` puro: a linha sai
 * com `purpose` nulo em vez do GUC.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

const ORG = "48920000-0000-4000-8000-000000000001";
const OUTRA_ORG = "48920000-0000-4000-8000-000000000002";
const GERENTE = "48920000-5555-4000-8000-000000000001";
const ESPECTADOR = "48920000-5555-4000-8000-000000000002";
const ESTRANHO = "48920000-5555-4000-8000-000000000003";
const CONTATO = "48920000-3333-4000-8000-000000000001";
const CPF = "52998224725";

const GUC = "guc_da_sessao";
const DA_FICHA = "ficha_do_contato";

function ultima(saida: string): string {
  return (saida.trim().split("\n").at(-1) ?? "").trim();
}

/**
 * Uma sessão psql só: role de sessão, claims do JWT, o GUC (quando pedido) e a
 * chamada. O GUC é o da SESSÃO porque é assim que quem chama por SQL o usa —
 * `set_config` no início do script, antes do `select`.
 */
function comoUsuario(usuario: string, chamada: string, guc?: string): string {
  const preparo = guc === undefined ? "" : `select set_config('app.decrypt_purpose', '${guc}', false);`;
  return sql(`set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${usuario}","role":"authenticated"}', false);
    ${preparo}
    select ${chamada};`);
}

function erroDe(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return motivoDoErro(err);
  }
  return "";
}

/**
 * A última linha de auditoria do contato para uma ação, no formato
 * `<purpose>|<tem a chave purpose?>`. O `coalesce` transforma o `null` em texto
 * para a asserção poder distinguir "chave ausente" de "chave com nulo".
 */
function ultimaTrilha(acao: string): string {
  return ultima(
    sql(`select coalesce(metadata->>'purpose', '<nulo>') || '|' || (metadata ? 'purpose')::text
           from public.api_audit_log
          where action = '${acao}' and resource_id = '${CONTATO}'
          order by created_at desc
          limit 1;`),
  );
}

function linhas(acao: string): string {
  return ultima(
    sql(`select count(*) from public.api_audit_log
          where action = '${acao}' and resource_id = '${CONTATO}';`),
  );
}

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${GERENTE}', 'cpf-9423-gerente@invariant.test'),
      ('${ESPECTADOR}', 'cpf-9423-viewer@invariant.test'),
      ('${ESTRANHO}', 'cpf-9423-estranho@invariant.test')
      on conflict do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG}', 'cpf-9423', 'Cpf 9423', 'Cpf 9423'),
      ('${OUTRA_ORG}', 'cpf-9423-b', 'Cpf 9423 B', 'Cpf 9423 B')
      on conflict do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${GERENTE}', '${ORG}', 'manager', now()),
      ('${ESPECTADOR}', '${ORG}', 'viewer', now()),
      ('${ESTRANHO}', '${OUTRA_ORG}', 'admin', now())
      on conflict do nothing;
    insert into private.app_secrets (name, value) values ('cpf_key', repeat('k', 44))
      on conflict (name) do update set value = excluded.value;
    insert into public.contacts (id, organization_id, name, cpf_hash, cpf_encrypted)
      values ('${CONTATO}', '${ORG}', 'Com CPF', 'hash-9423', public.encrypt_cpf('${CPF}'))
      on conflict (id) do nothing;
  `);
});

describe("o propósito da leitura do CPF sai na linha contact.cpf_decrypted (#4892)", () => {
  it("as DUAS assinaturas existem — a casca de 1 argumento não some", () => {
    // O texto devolvido é a própria prova do catálogo: são DUAS funções, e a de
    // um argumento continua registrada (é o que o export de contatos chama).
    expect(ultima(sql(`select to_regprocedure('public.decrypt_cpf(uuid)')::text;`))).toBe(
      "decrypt_cpf(uuid)",
    );
    expect(ultima(sql(`select to_regprocedure('public.decrypt_cpf(uuid,text)')::text;`))).toBe(
      "decrypt_cpf(uuid,text)",
    );
    expect(
      ultima(
        sql(`select to_regprocedure('public.decrypt_cpf(uuid)') is not null
                  and to_regprocedure('public.decrypt_cpf(uuid,text)') is not null;`),
      ),
    ).toBe("t");
  });

  it("o propósito passado como PARÂMETRO chega à linha do decrypt", () => {
    expect(ultima(comoUsuario(GERENTE, `public.decrypt_cpf('${CONTATO}', '${DA_FICHA}')`))).toBe(CPF);
    expect(ultimaTrilha("contact.cpf_decrypted")).toBe(`${DA_FICHA}|true`);
  });

  it("o PARÂMETRO vence o GUC da sessão", () => {
    expect(
      ultima(comoUsuario(GERENTE, `public.decrypt_cpf('${CONTATO}', '${DA_FICHA}')`, GUC)),
    ).toBe(CPF);
    expect(ultimaTrilha("contact.cpf_decrypted")).toBe(`${DA_FICHA}|true`);
  });

  it("sem parâmetro, o GUC da sessão continua auditado (o coalesce do corpo)", () => {
    // ⚠️ Este é o caso que cai se o corpo trocar `coalesce(p_purpose, ...)` por
    // `p_purpose` puro: o parâmetro é nulo e o propósito viraria nulo também.
    expect(ultima(comoUsuario(GERENTE, `public.decrypt_cpf('${CONTATO}', null)`, GUC))).toBe(CPF);
    expect(ultimaTrilha("contact.cpf_decrypted")).toBe(`${GUC}|true`);
  });

  it("a CASCA de 1 argumento devolve o CPF e repassa o GUC", () => {
    expect(ultima(comoUsuario(GERENTE, `public.decrypt_cpf('${CONTATO}')`, GUC))).toBe(CPF);
    expect(ultimaTrilha("contact.cpf_decrypted")).toBe(`${GUC}|true`);
  });

  it("sem GUC e sem parâmetro, a casca audita purpose nulo — o contrato da 0597", () => {
    expect(ultima(comoUsuario(GERENTE, `public.decrypt_cpf('${CONTATO}')`))).toBe(CPF);
    expect(ultimaTrilha("contact.cpf_decrypted")).toBe("<nulo>|true");
  });

  it("a assinatura de DOIS argumentos não afrouxa tenancy nem papel", () => {
    expect(
      erroDe(() => comoUsuario(ESPECTADOR, `public.decrypt_cpf('${CONTATO}', '${DA_FICHA}')`)),
    ).toContain("forbidden");
    expect(
      erroDe(() => comoUsuario(ESTRANHO, `public.decrypt_cpf('${CONTATO}', '${DA_FICHA}')`)),
    ).toContain("forbidden");
    // A casca também não é atalho: ela delega para o mesmo corpo guardado.
    expect(erroDe(() => comoUsuario(ESPECTADOR, `public.decrypt_cpf('${CONTATO}')`))).toContain(
      "forbidden",
    );
  });

  it("a LEITURA não grava `contact.updated`, e o decrypt fica uma linha por leitura", () => {
    // 5 leituras bem-sucedidas acima (2, 3, 4, 5 e 6); as três recusas não auditam.
    expect(linhas("contact.cpf_decrypted")).toBe("5");
    expect(linhas("contact.updated")).toBe("0");
  });
});
