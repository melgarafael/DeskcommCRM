import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  GOV_AGENT_A,
  GOV_ORG,
  GOV_VIEWER,
  columnExists,
  countAs,
  seedGov,
  sql,
  writeCountAs,
} from "./gov-helpers";

/**
 * O endereço da pessoa física é da ORGANIZAÇÃO, não do banco (#3494).
 *
 * As sete colunas chegaram na migration 9041 e a RLS de `contacts` é de linha —
 * coluna nova não ganha policy própria. Isso torna a pergunta barata e
 * obrigatória: a policy cobre a coluna nova por consequência, ou o endereço é o
 * primeiro dado sensível que vaza entre empresas?
 *
 * O que se mede, com Postgres de verdade e `request.jwt.claims` como o PostgREST
 * usa (`set role authenticated`):
 *
 *   1. as sete colunas existem — o teste não passa por ausência de schema;
 *   2. o agente da organização DONA lê e altera (controle positivo: sem ele,
 *      "ninguém vê" passaria com a tabela vazia);
 *   3. o usuário de OUTRA organização não vê a linha dela nem altera o endereço;
 *   4. endereço vazio continua sendo linha válida (pessoa física sem CEP).
 */
const ORG_B = "e9de3494-0000-4000-8000-00000000000b";
const USER_B = "e9de3494-1111-4000-8000-00000000000b";

const CONTATO_A = "e9de3494-3333-4000-8000-0000000000a1";
const CONTATO_A_SEM_ENDERECO = "e9de3494-3333-4000-8000-0000000000a2";
const CONTATO_B = "e9de3494-3333-4000-8000-0000000000b1";

const COLUNAS = [
  "zip_code",
  "street",
  "number",
  "complement",
  "district",
  "city",
  "state",
] as const;

function enderecoDe(id: string): Record<string, string | null> {
  const linha = sql(
    `select coalesce(zip_code, '<nulo>') || '|' || coalesce(street, '<nulo>') || '|' || coalesce(number, '<nulo>')
       from public.contacts where id = '${id}';`,
  );
  const [zip, street, number] = linha.split("|");
  return { zip_code: zip ?? null, street: street ?? null, number: number ?? null };
}

beforeAll(() => {
  seedGov();
  sql(`
    insert into auth.users (id, email)
      values ('${USER_B}', 'endereco-b@invariant.test') on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG_B}', 'endereco-inv-b', 'Endereço B', 'Endereço B') on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${USER_B}', '${ORG_B}', 'agent', now()) on conflict do nothing;

    insert into public.contacts (id, organization_id, name, display_name, zip_code, street, number, complement, district, city, state)
      values ('${CONTATO_A}', '${GOV_ORG}', 'Ana Souza', 'Ana Souza', '80000-000', 'Rua XV de Novembro', '120', 'apto 42', 'Centro', 'Curitiba', 'PR')
      on conflict (id) do nothing;
    -- Pessoa física sem CEP: cadastro válido, endereço todo nulo.
    insert into public.contacts (id, organization_id, name, display_name)
      values ('${CONTATO_A_SEM_ENDERECO}', '${GOV_ORG}', 'Sem Endereço', 'Sem Endereço')
      on conflict (id) do nothing;
    insert into public.contacts (id, organization_id, name, display_name, zip_code, street, city, state)
      values ('${CONTATO_B}', '${ORG_B}', 'Cliente da B', 'Cliente da B', '01001-000', 'Praça da Sé', 'São Paulo', 'SP')
      on conflict (id) do nothing;
  `);
});

afterAll(() => {
  // A limpeza é opcional (o container é efêmero), mas deixa o arquivo
  // reexecutável no mesmo Postgres sem duplicar endereço de controle.
  sql(`
    delete from public.contacts where id in ('${CONTATO_A}', '${CONTATO_A_SEM_ENDERECO}', '${CONTATO_B}');
  `);
});

describe("schema", () => {
  it("as sete colunas de endereço existem em contacts", () => {
    for (const coluna of COLUNAS) {
      expect({ coluna, existe: columnExists("contacts", coluna) }).toEqual({
        coluna,
        existe: true,
      });
    }
  });
});

describe("isolamento por organização", () => {
  it("o agente da organização dona lê o endereço (controle positivo)", () => {
    expect(
      countAs(
        GOV_AGENT_A,
        `select count(*) from public.contacts
          where id = '${CONTATO_A}'
            and organization_id = '${GOV_ORG}'
            and street = 'Rua XV de Novembro'
            and zip_code = '80000-000';`,
      ),
    ).toBe(1);
  });

  it("o agente da organização dona altera o endereço (controle positivo)", () => {
    expect(
      writeCountAs(
        GOV_AGENT_A,
        `update public.contacts set number = '121' where id = '${CONTATO_A}'`,
      ),
    ).toBe(1);
    expect(enderecoDe(CONTATO_A).number).toBe("121");
  });

  it("outra organização não vê o endereço da linha alheia", () => {
    expect(countAs(USER_B, `select count(*) from public.contacts where id = '${CONTATO_A}';`)).toBe(
      0,
    );
    // E não há leitura por COLUNA que escape da policy: nem um CEP alheio sai.
    expect(
      countAs(
        USER_B,
        `select count(*) from public.contacts
          where organization_id = '${GOV_ORG}' and zip_code is not null;`,
      ),
    ).toBe(0);
  });

  it("outra organização não altera o endereço alheio", () => {
    const linhas = writeCountAs(
      USER_B,
      `update public.contacts
          set street = 'Rua Invasora', zip_code = '99999-999'
        where id = '${CONTATO_A}'`,
    );

    expect(linhas).toBe(0);
    const atual = enderecoDe(CONTATO_A);
    expect(atual.street).toBe("Rua XV de Novembro");
    expect(atual.zip_code).toBe("80000-000");
  });

  it("o endereço de cada organização não aparece na leitura da outra", () => {
    // Controle dos dois lados: A não vê o de B, B não vê o de A.
    expect(
      countAs(
        GOV_AGENT_A,
        `select count(*) from public.contacts where id = '${CONTATO_B}' and zip_code is not null;`,
      ),
    ).toBe(0);
    expect(
      countAs(
        USER_B,
        `select count(*) from public.contacts
          where id = '${CONTATO_A}' and street is not null;`,
      ),
    ).toBe(0);
  });

  it("contato sem endereço é linha válida — os sete campos ficam nulos", () => {
    expect(
      countAs(
        GOV_VIEWER,
        `select count(*) from public.contacts
          where id = '${CONTATO_A_SEM_ENDERECO}'
            and zip_code is null and street is null and number is null
            and complement is null and district is null and city is null and state is null;`,
      ),
    ).toBe(1);
  });
});
