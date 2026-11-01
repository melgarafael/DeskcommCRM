import { beforeAll, describe, expect, it } from "vitest";

import {
  GOV_AGENT_A,
  GOV_MANAGER,
  GOV_ORG,
  GOV_VIEWER,
  countAs,
  lastLine,
  seedGov,
  sql,
  writeCountAs,
} from "./gov-helpers";

/**
 * Empresas, pessoas e importação (migrations 0448/0449 — metade B2B do #1621,
 * de @renatofortal). Roda só via `pnpm test:db`.
 *
 * Três perguntas, cada uma com o controle positivo que impede o verde por vazio:
 *
 *   1. ISOLAMENTO: quem é de outra organização não lê nem aponta para pessoa de
 *      cá (o caso original do autor, mantido).
 *   2. ESCRITA POR PAPEL, no banco: o PR nasceu com `for all` org-flat, e rota
 *      não é fronteira — com a anon key e o próprio JWT, um `viewer` escreveria
 *      pelo PostgREST o que a rota só deixa `manager` fazer.
 *   3. LGPD pelo caminho de produção: anonimizar o contato pela cascata canônica
 *      (`fn_lgpd_cascade_redact_contact`, a mesma dos dois botões) redige a
 *      pessoa, o vínculo e as linhas de planilha — e NÃO toca o outro telefone
 *      da mesma pessoa nem a empresa.
 */

const ORG_B = "b2b00000-0000-4000-8000-00000000000b";
const USER_B = "b2b00000-1111-4000-8000-00000000000b";

const EMPRESA = "b2b00000-2222-4000-8000-000000000001";
const PESSOA = "b2b00000-3333-4000-8000-000000000001";
const PESSOA_B = "b2b00000-3333-4000-8000-00000000000b";
const CONTATO_1 = "b2b00000-4444-4000-8000-000000000001";
const CONTATO_2 = "b2b00000-4444-4000-8000-000000000002";
const LOTE = "b2b00000-5555-4000-8000-000000000001";

beforeAll(() => {
  seedGov();
  sql(`
    insert into auth.users (id, email) values ('${USER_B}', 'b2b-b@invariant.test') on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG_B}', 'b2b-inv-b', 'B2B B', 'B2B B') on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${USER_B}', '${ORG_B}', 'manager', now()) on conflict do nothing;

    insert into public.companies (id, organization_id, trade_name, legal_name, normalized_cnpj, cnpj, email)
      values ('${EMPRESA}', '${GOV_ORG}', 'Globo', 'Globo LTDA', '55666777000199', '55.666.777/0001-99', 'contato@globo.invariant.test');
    insert into public.people (id, organization_id, full_name, normalized_name, email, notes)
      values ('${PESSOA}', '${GOV_ORG}', 'José Decisor', 'jose decisor', 'jose@invariant.test', 'prefere ligação à tarde');
    insert into public.people (id, organization_id, full_name)
      values ('${PESSOA_B}', '${ORG_B}', 'Outra Pessoa');
    insert into public.company_people (organization_id, company_id, person_id, job_title, department, is_decision_maker, notes)
      values ('${GOV_ORG}', '${EMPRESA}', '${PESSOA}', 'Diretor financeiro', 'Financeiro', true, 'assina acima de 10 mil');
    insert into public.contacts (id, organization_id, name, display_name, phone_number, person_id, source) values
      ('${CONTATO_1}', '${GOV_ORG}', 'José', 'José', '+5585999991111', '${PESSOA}', 'import_csv'),
      ('${CONTATO_2}', '${GOV_ORG}', 'José', 'José', '+5585988881111', '${PESSOA}', 'import_csv');
    insert into public.import_batches (id, organization_id, filename)
      values ('${LOTE}', '${GOV_ORG}', 'clientes.csv');
    insert into public.import_rows (organization_id, batch_id, row_number, raw_data, normalized_data, status, error, contact_id, person_id) values
      ('${GOV_ORG}', '${LOTE}', 2, '{"Pessoa": "José Decisor", "Telefone": "85999991111"}', '{"phone": "85999991111"}', 'success', null, '${CONTATO_1}', '${PESSOA}'),
      ('${GOV_ORG}', '${LOTE}', 3, '{"Pessoa": "José Decisor", "Telefone": "85988881111"}', '{"phone": "85988881111"}', 'success', null, '${CONTATO_2}', '${PESSOA}'),
      ('${GOV_ORG}', '${LOTE}', 4, '{"Pessoa": "Maria Outra"}', '{}', 'failed', 'Telefone inválido.', null, null);
  `);
});

describe("isolamento entre organizações", () => {
  it("as cinco tabelas e contacts.person_id existem", () => {
    expect(
      lastLine(
        sql(`select count(*) from information_schema.tables where table_schema='public'
               and table_name in ('companies','people','company_people','import_batches','import_rows');`),
      ),
    ).toBe("5");
    expect(
      lastLine(
        sql(`select count(*) from information_schema.columns
               where table_schema='public' and table_name='contacts' and column_name='person_id';`),
      ),
    ).toBe("1");
  });

  it("quem é de B não lê a empresa nem a pessoa de A; quem é de A lê (controle)", () => {
    expect(countAs(USER_B, `select count(*) from public.companies where organization_id = '${GOV_ORG}';`)).toBe(0);
    expect(countAs(USER_B, `select count(*) from public.people where organization_id = '${GOV_ORG}';`)).toBe(0);
    expect(countAs(GOV_VIEWER, `select count(*) from public.companies where id = '${EMPRESA}';`)).toBe(1);
  });

  it("contato de A não aponta para pessoa de B (gatilho de mesma organização)", () => {
    expect(() =>
      sql(`update public.contacts set person_id = '${PESSOA_B}' where id = '${CONTATO_1}';`),
    ).toThrow(/organization_id deve coincidir/);
  });

  it("mesmo CNPJ na mesma organização é recusado (único parcial)", () => {
    expect(() =>
      sql(`insert into public.companies (organization_id, trade_name, normalized_cnpj)
             values ('${GOV_ORG}', 'Globo 2', '55666777000199');`),
    ).toThrow(/companies_org_normalized_cnpj_uidx/);
  });

  it("contato do WhatsApp continua nascendo sem pessoa", () => {
    expect(
      lastLine(
        sql(`with novo as (
               insert into public.contacts (organization_id, name, display_name, phone_number, source)
               values ('${GOV_ORG}', 'Desconhecido', 'Desconhecido', '+5585111222333', 'whatsapp')
               returning person_id)
             select (person_id is null)::text from novo;`),
      ),
    ).toBe("true");
  });
});

describe("escrita por papel no banco (RLS por operação)", () => {
  it("viewer e agent não criam empresa; manager cria", () => {
    const criar = (nome: string) =>
      `insert into public.companies (organization_id, trade_name) values ('${GOV_ORG}', '${nome}')`;
    expect(writeCountAs(GOV_VIEWER, criar("pelo viewer"))).toBe(0);
    expect(writeCountAs(GOV_AGENT_A, criar("pelo agent"))).toBe(0);
    expect(writeCountAs(GOV_MANAGER, criar("pelo manager"))).toBe(1);
  });

  it("viewer não edita a pessoa; agent edita (o PATCH da rota é agent)", () => {
    const editar = `update public.people set notes = 'editado' where id = '${PESSOA}'`;
    expect(writeCountAs(GOV_VIEWER, editar)).toBe(0);
    expect(writeCountAs(GOV_AGENT_A, editar)).toBe(1);
  });

  it("agent não escreve no importador; manager escreve", () => {
    const lote = `insert into public.import_batches (organization_id, filename) values ('${GOV_ORG}', 'x.csv')`;
    expect(writeCountAs(GOV_AGENT_A, lote)).toBe(0);
    expect(writeCountAs(GOV_MANAGER, lote)).toBe(1);
  });

  it("manager de B não cria empresa em A", () => {
    expect(
      writeCountAs(USER_B, `insert into public.companies (organization_id, trade_name) values ('${GOV_ORG}', 'invasora')`),
    ).toBe(0);
  });
});

describe("LGPD: anonimizar o contato alcança pessoa, vínculo e planilha", () => {
  beforeAll(() => {
    sql(`select public.fn_lgpd_cascade_redact_contact('${GOV_ORG}', '${CONTATO_1}', gen_random_uuid());`);
  });

  it("a pessoa perde nome, e-mail e anotações", () => {
    expect(
      lastLine(
        sql(`select full_name || '|' || coalesce(email, '∅') || '|' || coalesce(notes, '∅') || '|' || coalesce(normalized_name, '∅')
               from public.people where id = '${PESSOA}';`),
      ),
    ).toBe("Pessoa anonimizada #b2b00000|∅|∅|∅");
  });

  it("o vínculo perde cargo, departamento e anotações, e fica", () => {
    expect(
      lastLine(
        sql(`select coalesce(job_title, '∅') || '|' || coalesce(department, '∅') || '|' || coalesce(notes, '∅') || '|' || is_decision_maker::text
               from public.company_people where person_id = '${PESSOA}';`),
      ),
    ).toBe("∅|∅|∅|true");
  });

  it("as linhas de planilha do contato E da pessoa são zeradas; a de outra pessoa fica", () => {
    const linhas = sql(`select row_number || ':' || raw_data::text || ':' || normalized_data::text || ':' || coalesce(error, '∅')
                          from public.import_rows where batch_id = '${LOTE}' order by row_number;`).split("\n");
    expect(linhas).toEqual([
      "2:{}:{}:∅",
      "3:{}:{}:∅",
      '4:{"Pessoa": "Maria Outra"}:{}:Telefone inválido.',
    ]);
  });

  it("o OUTRO telefone da pessoa e a empresa não são tocados", () => {
    expect(
      lastLine(sql(`select is_anonymized::text || '|' || phone_number from public.contacts where id = '${CONTATO_2}';`)),
    ).toBe("false|+5585988881111");
    expect(
      lastLine(sql(`select legal_name || '|' || email from public.companies where id = '${EMPRESA}';`)),
    ).toBe("Globo LTDA|contato@globo.invariant.test");
  });
});

/**
 * O CNPJ alfanumérico da Receita na COLUNA (#3495). O código passou a aceitar as
 * 12 posições de dígito ou letra + 2 dígitos verificadores; se o CHECK continuasse
 * `^\d{14}$`, o documento legítimo morreria no INSERT com 500 — por isso a régua
 * de banco entra nesta suíte, e não só no teste de texto do schema.
 */
describe("normalized_cnpj aceita o CNPJ alfanumérico da Receita (#3495)", () => {
  const inserir = (nome: string, documento: string) =>
    sql(`insert into public.companies (organization_id, trade_name, normalized_cnpj)
           values ('${GOV_ORG}', '${nome}', '${documento}');`);

  it("aceita as 12 posições alfanuméricas em MAIÚSCULA + os 2 dígitos", () => {
    expect(() => inserir("Alfa", "12ABC34501DE35")).not.toThrow();
    expect(
      lastLine(sql(`select count(*) from public.companies where normalized_cnpj = '12ABC34501DE35';`)),
    ).toBe("1");
  });

  it("recusa a forma minúscula: a coluna guarda a única forma canônica", () => {
    expect(() => inserir("Alfa minúscula", "12abc34501de35")).toThrow(
      /companies_normalized_cnpj_digits/,
    );
  });

  it("continua recusando 13 posições — o CHECK segue sendo cerca de formato", () => {
    expect(() => inserir("Curta", "12ABC34501DE3")).toThrow(/companies_normalized_cnpj_digits/);
  });
});
