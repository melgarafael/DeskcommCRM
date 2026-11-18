/**
 * 9094 — O AVISO À EQUIPE COM MODELO APROVADO, medido no banco que o kit aplica.
 *
 * `config_aviso_de_caso.modelo_id` aponta para `meta_templates` por uma FK
 * COMPOSTA com a organização: o banco recusa o modelo do vizinho mesmo numa
 * escrita que não passe pela função. Mas FK não sabe de conexão: sozinha, ela
 * aceitaria o modelo de outro número da mesma organização — e o envio sairia
 * com uma definição que esta conexão não tem. Quem impede é
 * `fn_definir_aviso_de_caso`, na mesma transação da escrita. Este arquivo
 * prova as duas recusas da função, a recusa da FK sem a função, o controle
 * positivo (inclusive a linha do número oficial direto, gravada SEM conexão e
 * casada pela conta), a convivência com o destino `responsavel` da 9078, a
 * limpeza com `null`, o `on delete set null (modelo_id)` e a assinatura nova
 * sem `EXECUTE` para anon.
 *
 * "Aprovado" e "uma variável só" NÃO são perguntas daqui: moram no espelho e
 * no contrato derivado (`lib/escalacao/modelo-do-aviso.ts`), e a rota as faz
 * antes do RPC — `tests/unit/aviso-por-modelo-rota.test.ts`.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

// Namespace próprio (90940000-).
const ORG_A = "90940000-0000-4000-8000-000000000001";
const ORG_B = "90940000-0000-4000-8000-000000000002";
const ADMIN_A = "90940000-1111-4000-8000-000000000001";
const SESSAO_A = "90940000-2222-4000-8000-000000000001";
const SESSAO_A2 = "90940000-2222-4000-8000-000000000002";
const SESSAO_B = "90940000-2222-4000-8000-000000000003";
const SESSAO_OFICIAL_A = "90940000-2222-4000-8000-000000000004";
const MODELO_A = "90940000-3333-4000-8000-000000000001";
const MODELO_A2 = "90940000-3333-4000-8000-000000000002";
const MODELO_B = "90940000-3333-4000-8000-000000000003";
const MODELO_DA_CONTA = "90940000-3333-4000-8000-000000000004";
const MODELO_DESCARTAVEL = "90940000-3333-4000-8000-000000000005";

function comoMembro(userId: string): string {
  return `set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);`;
}

function valor(consulta: string): string {
  return (sql(consulta).trim().split("\n").at(-1) ?? "").trim();
}

function define(canal: string, modelo: string | null): string {
  const p = modelo === null ? "null" : `'${modelo}'`;
  return `${comoMembro(ADMIN_A)}
    select public.fn_definir_aviso_de_caso('${ORG_A}', '${canal}', '+5531900000001', null, false, false, false,
      p_modelo => ${p});`;
}

function erroDe(script: string): string {
  try {
    sql(script);
    return "";
  } catch (e) {
    return motivoDoErro(e);
  }
}

const CORPO = `'[{"type":"BODY","text":"Aviso: {{1}}"}]'::jsonb`;

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values ('${ADMIN_A}', 'aviso-9094-admin-a@invariant.test')
      on conflict do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'aviso-9094-a', 'Aviso 9094 A', 'Aviso 9094 A'),
      ('${ORG_B}', 'aviso-9094-b', 'Aviso 9094 B', 'Aviso 9094 B')
      on conflict do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${ADMIN_A}', '${ORG_A}', 'admin', now()) on conflict do nothing;

    do $seed$ begin
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
        values ('${SESSAO_A}', '${ORG_A}', 'aviso-9094-a', '\\x00'::bytea);
    exception when unique_violation then null; end $seed$;
    do $seed$ begin
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
        values ('${SESSAO_A2}', '${ORG_A}', 'aviso-9094-a2', '\\x00'::bytea);
    exception when unique_violation then null; end $seed$;
    do $seed$ begin
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
        values ('${SESSAO_B}', '${ORG_B}', 'aviso-9094-b', '\\x00'::bytea);
    exception when unique_violation then null; end $seed$;
    do $seed$ begin
      insert into public.channel_sessions (id, organization_id, provider, meta_phone_number_id, meta_waba_id, status, webhook_secret_encrypted)
        values ('${SESSAO_OFICIAL_A}', '${ORG_A}', 'meta_cloud', '9094-pn', '9094-conta', 'WORKING', '\\x00'::bytea);
    exception when unique_violation then null; end $seed$;

    insert into public.meta_templates (id, organization_id, waba_id, name, language, status, components, contract_hash, channel_session_id) values
      ('${MODELO_A}',  '${ORG_A}', 'conta-a',    'aviso_a', 'pt_BR', 'APPROVED', ${CORPO}, '', '${SESSAO_A}'),
      ('${MODELO_A2}', '${ORG_A}', 'conta-a2',   'aviso_a2', 'pt_BR', 'APPROVED', ${CORPO}, '', '${SESSAO_A2}'),
      ('${MODELO_B}',  '${ORG_B}', 'conta-b',    'aviso_b', 'pt_BR', 'APPROVED', ${CORPO}, '', '${SESSAO_B}'),
      ('${MODELO_DA_CONTA}', '${ORG_A}', '9094-conta', 'aviso_conta', 'pt_BR', 'APPROVED', ${CORPO}, '', null),
      ('${MODELO_DESCARTAVEL}', '${ORG_A}', 'conta-a', 'aviso_descartavel', 'pt_BR', 'APPROVED', ${CORPO}, '', '${SESSAO_A}')
      on conflict do nothing;
  `);
});

describe("9094 — o modelo é desta organização e desta conexão", () => {
  it("CONTROLE POSITIVO: o modelo da própria conexão é gravado", () => {
    sql(define(SESSAO_A, MODELO_A));
    expect(valor(`select modelo_id from public.config_aviso_de_caso where organization_id = '${ORG_A}'`)).toBe(
      MODELO_A,
    );
  });

  it("o modelo do VIZINHO é recusado pela função, com o código que a rota traduz", () => {
    expect(erroDe(define(SESSAO_A, MODELO_B))).toMatch(/aviso_de_caso_modelo_invalido/);
  });

  it("…e pela FK composta, numa escrita que nem passa pela função", () => {
    sql(define(SESSAO_A, MODELO_A));
    expect(
      erroDe(`update public.config_aviso_de_caso set modelo_id = '${MODELO_B}' where organization_id = '${ORG_A}';`),
    ).toMatch(/config_aviso_de_caso_modelo_org_fkey|foreign key/);
    expect(valor(`select modelo_id from public.config_aviso_de_caso where organization_id = '${ORG_A}'`)).toBe(
      MODELO_A,
    );
  });

  it("o modelo de OUTRO número da mesma organização é recusado", () => {
    expect(erroDe(define(SESSAO_A, MODELO_A2))).toMatch(/aviso_de_caso_modelo_invalido/);
  });

  it("no número oficial direto, a linha SEM conexão da conta dele serve", () => {
    sql(define(SESSAO_OFICIAL_A, MODELO_DA_CONTA));
    expect(valor(`select modelo_id from public.config_aviso_de_caso where organization_id = '${ORG_A}'`)).toBe(
      MODELO_DA_CONTA,
    );
  });

  it("…e a mesma linha sem conexão NÃO serve a outro número", () => {
    expect(erroDe(define(SESSAO_A, MODELO_DA_CONTA))).toMatch(/aviso_de_caso_modelo_invalido/);
  });

  it("`null` limpa o modelo — é o que a troca para texto livre grava", () => {
    sql(define(SESSAO_A, MODELO_A));
    sql(define(SESSAO_A, null));
    expect(valor(`select coalesce(modelo_id::text, 'nulo') from public.config_aviso_de_caso where organization_id = '${ORG_A}'`)).toBe(
      "nulo",
    );
  });

  it("o modelo convive com o destino `responsavel` (9078): os dois são gravados", () => {
    sql(`${comoMembro(ADMIN_A)}
      select public.fn_definir_aviso_de_caso('${ORG_A}', '${SESSAO_A}', '+5531900000001', null, false, false, false,
        p_destino_modo => 'responsavel', p_modelo => '${MODELO_A}');`);
    expect(
      valor(`select destino_modo || ':' || modelo_id from public.config_aviso_de_caso where organization_id = '${ORG_A}'`),
    ).toBe(`responsavel:${MODELO_A}`);
  });

  it("a chamada de 7 argumentos segue valendo e grava sem modelo", () => {
    sql(define(SESSAO_A, MODELO_A));
    sql(`${comoMembro(ADMIN_A)}
      select public.fn_definir_aviso_de_caso('${ORG_A}', '${SESSAO_A}', '+5531900000001', null, false, false, false);`);
    expect(valor(`select coalesce(modelo_id::text, 'nulo') from public.config_aviso_de_caso where organization_id = '${ORG_A}'`)).toBe(
      "nulo",
    );
  });
});

describe("9094 — apagar o modelo não apaga nem trava a configuração", () => {
  it("o DELETE do modelo passa, e a configuração fica sem modelo", () => {
    sql(define(SESSAO_A, MODELO_DESCARTAVEL));
    sql(`delete from public.meta_templates where id = '${MODELO_DESCARTAVEL}';`);
    expect(
      valor(`select coalesce(modelo_id::text, 'nulo') || ':' || channel_session_id from public.config_aviso_de_caso where organization_id = '${ORG_A}'`),
    ).toBe(`nulo:${SESSAO_A}`);
  });
});

describe("9094 — a assinatura nova", () => {
  it("anon não tem EXECUTE na função de 10 parâmetros", () => {
    expect(
      valor(
        `select has_function_privilege('anon', 'public.fn_definir_aviso_de_caso(uuid,uuid,text,text,boolean,boolean,boolean,text,jsonb,uuid)', 'EXECUTE')::text`,
      ),
    ).toBe("false");
  });

  it("a de 9 parâmetros não existe mais — senão o PostgREST teria duas", () => {
    expect(
      valor(
        `select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'fn_definir_aviso_de_caso'`,
      ),
    ).toBe("1");
  });
});
