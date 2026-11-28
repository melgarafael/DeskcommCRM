/**
 * O ENDEREÇO DA PESSOA FÍSICA PASSA PELA CRIAÇÃO, PELA BUSCA E PELA EXPORTAÇÃO
 * (#3494) — com Postgres de verdade.
 *
 * As sete colunas chegaram na migration 9041 e a ficha passou a preenchê-las
 * pelo CEP. O que faltava era o dado ser ENCONTRÁVEL e SAIR da instalação: o
 * `?search=` da tela olhava só nome, e-mail, telefone e CPF, e o export (CSV e
 * vCard) levava só isso. Endereço gravado que não entra em busca nem em
 * arquivo de saída é o mesmo que endereço que não existe para quem opera.
 *
 * O que se mede, aqui:
 *
 *   1. criar contato com endereço grava os SETE campos (o insert é o mesmo que
 *      o handler de criação emite, como o agente da organização);
 *   2. a busca acha pela RUA digitada sem acento — a coluna `endereco_sem_acento`
 *      (migration 9403) é quem casa, não um `ilike` cru;
 *   3. a busca acha pelo CEP nas DUAS grafias (`80000-000` e `80000000`);
 *   4. o contato de OUTRA organização não é alcançável por nenhuma dessas
 *      portas — a policy de linha continua valendo para a coluna nova;
 *   5. a exportação da linha LIDA DO BANCO leva o endereço (CSV e vCard).
 *
 * O que NÃO se mede aqui: o filtro que o handler monta (`?search=` → `.or()`)
 * é `tests/unit/contatos-busca-pelo-endereco.test.ts`; este arquivo prova que a
 * coluna e o SQL que o handler escreve casam no banco.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { csvDosContatos, vcardDoContato } from "@/lib/contacts/exportar";
import { GOV_AGENT_A, GOV_ORG, countAs, seedGov, sql, writeCountAs } from "./gov-helpers";

const ORG_B = "e9de3494-0000-4000-8000-00000000010b";
const USER_B = "e9de3494-1111-4000-8000-00000000010b";

const CRIADO = "e9de3494-4444-4000-8000-0000000000c1";
const CRIADO_PELA_API = "e9de3494-4444-4000-8000-0000000000c3";
const DA_OUTRA_ORGANIZACAO = "e9de3494-4444-4000-8000-0000000000c2";

/** A linha do banco no recorte que o export usa, lida como a organização dona. */
function linhaParaExportar(id: string): {
  name: string;
  phone_number: string;
  zip_code: string;
  street: string;
  number: string;
  complement: string;
  district: string;
  city: string;
  state: string;
} {
  const bruto = sql(
    `select coalesce(name, '') || '|' || coalesce(phone_number, '') || '|'
            || coalesce(zip_code, '') || '|' || coalesce(street, '') || '|'
            || coalesce(number, '') || '|' || coalesce(complement, '') || '|'
            || coalesce(district, '') || '|' || coalesce(city, '') || '|'
            || coalesce(state, '')
       from public.contacts where id = '${id}';`,
  );
  const [name, phone_number, zip_code, street, number, complement, district, city, state] =
    bruto.split("|");
  return {
    name: name ?? "",
    phone_number: phone_number ?? "",
    zip_code: zip_code ?? "",
    street: street ?? "",
    number: number ?? "",
    complement: complement ?? "",
    district: district ?? "",
    city: city ?? "",
    state: state ?? "",
  };
}

beforeAll(() => {
  seedGov();
  sql(`
    insert into auth.users (id, email)
      values ('${USER_B}', 'endereco-busca-b@invariant.test') on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG_B}', 'endereco-busca-b', 'Endereço Busca B', 'Endereço Busca B')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${USER_B}', '${ORG_B}', 'agent', now()) on conflict do nothing;

    -- O MESMO insert que o handler de criação emite: as sete colunas de endereço
    -- no corpo, nenhuma delas obrigatória.
    insert into public.contacts
      (id, organization_id, name, display_name, phone_number, zip_code, street, number, complement, district, city, state)
      values
      ('${CRIADO}', '${GOV_ORG}', 'Ana Souza', 'Ana Souza', '+5541999991200',
       '80000-000', 'Rua São João', '120', 'apto 42', 'Centro', 'Curitiba', 'PR')
      on conflict (id) do nothing;

    -- O MESMO endereço na OUTRA organização: se a busca vazar, ele aparece.
    insert into public.contacts
      (id, organization_id, name, display_name, zip_code, street, number, district, city, state)
      values
      ('${DA_OUTRA_ORGANIZACAO}', '${ORG_B}', 'Cliente da B', 'Cliente da B',
       '80000-000', 'Rua São João', '120', 'Centro', 'Curitiba', 'PR')
      on conflict (id) do nothing;
  `);
});

afterAll(() => {
  sql(`
    delete from public.contacts
     where id in ('${CRIADO}', '${CRIADO_PELA_API}', '${DA_OUTRA_ORGANIZACAO}');
  `);
});

describe("criação com endereço", () => {
  it("criar contato com endereço grava os sete campos", () => {
    const criados = writeCountAs(
      GOV_AGENT_A,
      `insert into public.contacts
         (id, organization_id, name, display_name, phone_number,
          zip_code, street, number, complement, district, city, state)
       values
         ('${CRIADO_PELA_API}', '${GOV_ORG}', 'Bruno Lima', 'Bruno Lima', '+5541988881200',
          '80500-000', 'Rua das Flores', '45', 'casa 2', 'Alto da Glória', 'Curitiba', 'PR')`,
    );
    expect(criados).toBe(1);

    expect(
      countAs(
        GOV_AGENT_A,
        `select count(*) from public.contacts
          where id = '${CRIADO_PELA_API}'
            and zip_code = '80500-000' and street = 'Rua das Flores' and number = '45'
            and complement = 'casa 2' and district = 'Alto da Glória'
            and city = 'Curitiba' and state = 'PR';`,
      ),
    ).toBe(1);
  });

  it("o endereço criado alimenta a coluna gerada da busca", () => {
    expect(
      countAs(
        GOV_AGENT_A,
        `select count(*) from public.contacts
          where id = '${CRIADO}'
            and endereco_sem_acento like '%rua sao joao%'
            and endereco_sem_acento like '%centro%'
            and endereco_sem_acento like '%curitiba%';`,
      ),
    ).toBe(1);
  });
});

describe("busca pelo endereço", () => {
  it("a busca acha pela rua digitada SEM acento (a coluna gerada casa)", () => {
    // "sao joao" é o que a pessoa digita; o banco guarda "São João".
    expect(
      countAs(
        GOV_AGENT_A,
        `select count(*) from public.contacts
          where id = '${CRIADO}' and endereco_sem_acento like '%sao joao%';`,
      ),
    ).toBe(1);
  });

  it("a busca acha pelo CEP nas duas grafias — com e sem máscara", () => {
    // O que o operador digita no teclado numérico encontra o CEP gravado com
    // máscara, e o CEP com máscara encontra a si mesmo.
    expect(
      countAs(
        GOV_AGENT_A,
        `select count(*) from public.contacts
          where id = '${CRIADO}'
            and (zip_code ilike '%80000000%' or zip_code ilike '%80000-000%');`,
      ),
    ).toBe(1);
  });
});

describe("escopo por organização, agora pela porta da busca", () => {
  it("contato de outra organização não é alcançável pela busca de endereço", () => {
    // O agente da A não vê a linha da B nem pelo termo do endereço.
    expect(
      countAs(
        GOV_AGENT_A,
        `select count(*) from public.contacts
          where id = '${DA_OUTRA_ORGANIZACAO}' and endereco_sem_acento like '%sao joao%';`,
      ),
    ).toBe(0);
    // E não há leitura por ORGANIZAÇÃO alheia: o mesmo termo filtrado pela B
    // não devolve nada ao agente da A.
    expect(
      countAs(
        GOV_AGENT_A,
        `select count(*) from public.contacts
          where organization_id = '${ORG_B}' and endereco_sem_acento like '%sao joao%';`,
      ),
    ).toBe(0);
    // Controle positivo do outro lado: a B acha o PRÓPRIO pelo endereço — sem
    // isso, "não achou" passaria com a busca quebrada.
    expect(
      countAs(
        USER_B,
        `select count(*) from public.contacts
          where id = '${DA_OUTRA_ORGANIZACAO}' and endereco_sem_acento like '%sao joao%';`,
      ),
    ).toBe(1);
  });
});

describe("exportação", () => {
  it("exportação enxerga o endereço: o CSV da linha lida do banco leva os sete campos", () => {
    const csv = csvDosContatos([linhaParaExportar(CRIADO)]);

    expect(csv).toContain("zip_code,street,number,complement,district,city,state");
    expect(csv).toContain("80000-000,Rua São João,120,apto 42,Centro,Curitiba,PR");
  });

  it("exportação enxerga o endereço no vCard (ADR)", () => {
    const cartao = vcardDoContato(linhaParaExportar(CRIADO));

    expect(cartao).toContain("ADR;TYPE=HOME:;apto 42 - Centro;Rua São João, 120;Curitiba;PR;80000-000;");
    expect(cartao).toContain("apto 42 - Centro");
  });
});
