import { beforeAll, describe, expect, it } from "vitest";

import { countAs, sql, writeCountAs } from "./gov-helpers";

/**
 * ISOLAMENTO DE `demandas` E `demanda_conversas` ENTRE ORGANIZAÇÕES, por JWT.
 *
 * As duas tabelas nasceram na 0136 com RLS ligada e policy de tenant, e estão em
 * `DEBITO_CONHECIDO` de `rls-completude-varredura.test.ts`: RLS ligada, nenhuma
 * prova de comportamento. A demanda carrega quem é o cliente (`contact_id`), o
 * que ele pediu (`assunto`), o que lhe foi prometido (`proximo_passo`) e o
 * desfecho — o dossiê do atendimento. As duas tabelas recebem CRUD inteiro de
 * `authenticated` pelo `ALTER DEFAULT PRIVILEGES` do baseline, então a única
 * coisa entre a organização A e o que o cliente da B pediu é a policy.
 *
 * Arquivo NOVO em vez de linha em `TABLES` de `rls-isolation.test.ts`, porque
 * `tests/invariants/` é congelado para edição. A consequência, declarada: as
 * duas tabelas seguem listadas em `DEBITO_CONHECIDO` até alguém com a
 * justificativa escrita movê-las para `PROVA_PROPRIA` citando este arquivo.
 *
 * Semeadas EXPLICITAMENTE, e não pelo efeito colateral do trigger de `messages`
 * da 0138: se o trigger mudar, o controle positivo continua medindo a RLS
 * destas tabelas em vez de virar zero por falta de linha.
 */

// Namespace pela migration (0392), como manda meta-templates-rls.test.ts.
const ORG_A = "0392aaaa-0000-4000-8000-000000000001";
const ORG_B = "0392bbbb-0000-4000-8000-000000000002";
const USER_A = "0392aaaa-1111-4000-8000-000000000001";
const USER_B = "0392bbbb-1111-4000-8000-000000000002";
const SESS_A = "0392aaaa-2222-4000-8000-000000000001";
const SESS_B = "0392bbbb-2222-4000-8000-000000000002";
const CT_A = "0392aaaa-3333-4000-8000-000000000001";
const CT_B = "0392bbbb-3333-4000-8000-000000000002";
const CV_A = "0392aaaa-4444-4000-8000-000000000001";
const CV_B = "0392bbbb-4444-4000-8000-000000000002";
const DM_A = "0392aaaa-5555-4000-8000-000000000001";
const DM_B = "0392bbbb-5555-4000-8000-000000000002";

function semear(org: string, user: string, sess: string, ct: string, cv: string, dm: string, tag: string): string {
  return `
    insert into auth.users (id, email) values ('${user}', 'dm-${tag}@invariant.test')
      on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${org}', 'dm-inv-${tag}', 'Demandas Inv ${tag}', 'DM ${tag}')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${user}', '${org}', 'agent', now())
      on conflict do nothing;
    insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
      values ('${sess}', '${org}', 'dm-inv-${tag}', '\\x00'::bytea)
      on conflict (id) do nothing;
    insert into public.contacts (id, organization_id, display_name)
      values ('${ct}', '${org}', 'Demandas Inv Contact ${tag}')
      on conflict (id) do nothing;
    insert into public.conversations (id, organization_id, contact_id, channel_session_id)
      values ('${cv}', '${org}', '${ct}', '${sess}')
      on conflict (id) do nothing;
    insert into public.demandas (id, organization_id, contact_id, origem, estado, dono_kind, assunto, proximo_passo)
      values ('${dm}', '${org}', '${ct}', 'manual', 'aberta', 'ia', 'assunto da org ${tag}', 'sonda de invariante')
      on conflict (id) do nothing;
    insert into public.demanda_conversas (organization_id, demanda_id, conversation_id)
      values ('${org}', '${dm}', '${cv}')
      on conflict do nothing;
  `;
}

beforeAll(() => {
  sql(
    semear(ORG_A, USER_A, SESS_A, CT_A, CV_A, DM_A, "a") +
      semear(ORG_B, USER_B, SESS_B, CT_B, CV_B, DM_B, "b"),
  );
});

describe.each(["demandas", "demanda_conversas"] as const)("RLS de %s", (tabela) => {
  it("controle positivo: cada usuário lê a linha da PRÓPRIA organização", () => {
    // Sem isto, um zero abaixo poderia ser falta de linha ou de privilégio, não RLS.
    expect(
      countAs(USER_A, `select count(*) from public.${tabela} where organization_id = '${ORG_A}';`),
    ).toBe(1);
    expect(
      countAs(USER_B, `select count(*) from public.${tabela} where organization_id = '${ORG_B}';`),
    ).toBe(1);
  });

  it("usuário de A NÃO lê nada de B, e o de B nada de A", () => {
    expect(
      countAs(USER_A, `select count(*) from public.${tabela} where organization_id = '${ORG_B}';`),
    ).toBe(0);
    expect(
      countAs(USER_B, `select count(*) from public.${tabela} where organization_id = '${ORG_A}';`),
    ).toBe(0);
  });

  it("usuário de A NÃO altera nem apaga a linha de B", () => {
    expect(
      writeCountAs(
        USER_A,
        `update public.${tabela} set organization_id = organization_id where organization_id = '${ORG_B}'`,
      ),
    ).toBe(0);
    expect(
      writeCountAs(USER_A, `delete from public.${tabela} where organization_id = '${ORG_B}'`),
    ).toBe(0);
    expect(
      countAs(USER_B, `select count(*) from public.${tabela} where organization_id = '${ORG_B}';`),
    ).toBe(1);
  });
});

describe("o lado `with check`: usuário de A NÃO escreve COM o organization_id de B", () => {
  it("demandas", () => {
    expect(
      writeCountAs(
        USER_A,
        `insert into public.demandas (organization_id, contact_id, origem, estado, dono_kind)
           values ('${ORG_B}', '${CT_B}', 'manual', 'aberta', 'ia')`,
      ),
    ).toBe(0);
  });

  it("demanda_conversas", () => {
    // A demanda e a conversa são de B: o vínculo novo só pode ser recusado pela
    // policy. O par (DM_B, CV_A) não existe, então não há conflito de chave.
    expect(
      writeCountAs(
        USER_A,
        `insert into public.demanda_conversas (organization_id, demanda_id, conversation_id)
           values ('${ORG_B}', '${DM_B}', '${CV_A}')`,
      ),
    ).toBe(0);
  });
});
