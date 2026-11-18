import { beforeAll, describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

/**
 * O NÚMERO DO TITULAR APAGADO A PEDIDO NÃO VOLTA PELA AGENDA DO APP — e a
 * pergunta em LOTE responde o MESMO que a pergunta unitária.
 *
 * A sincronização de contatos da coexistência (`smb_app_state_sync`) só respeita
 * o apagamento se a pergunta que ela faz antes de escrever disser "sim" para
 * TODAS as grafias do número que a agenda pode entregar. A unitária
 * (`fn_titular_apagado_a_pedido`) já é a régua do importador de histórico desde
 * a 0750; a 9321 acrescentou a versão de lote (`fn_titulares_apagados_a_pedido`)
 * para o webhook não pagar uma consulta por contato.
 *
 * Duas perguntas, então, e é isso que se prova aqui:
 *   - o dado NÃO existe: depois da anonimização não sobra ficha viva com
 *     nenhuma grafia do número, em nenhuma tabela de contato;
 *   - a resposta é a MESMA nas duas funções, para cada grafia, e o lote nunca
 *     devolve o número de outra pessoa nem o de outra organização.
 */

const ORG_A = "9222a000-0000-4000-8000-00000000000a";
const ORG_B = "9222a000-0000-4000-8000-00000000000b";
const MEMBRO_A = "9222a000-1111-4000-8000-000000000001";
const APAGADO = "9222a000-2222-4000-8000-000000000001";
const NORMAL = "9222a000-2222-4000-8000-000000000002";
const MESMO_NUMERO_EM_B = "9222a000-2222-4000-8000-000000000003";
const TELEFONE = "5519977776666";
const OUTRO = "5519966665555";
/**
 * As grafias do MESMO número, tiradas da função do banco em vez de digitadas à
 * mão: é essa lista que a agenda do app pode entregar, e um dígito trocado aqui
 * faria o teste medir outro número.
 */
let VARIANTES: string[] = [];
const comMais = (telefone: string) => `'+${telefone}'`;

const lista = (telefones: string[] | null): string => {
  if (telefones === null) return "null";
  return `array[${telefones.map((t) => `'${t}'`).join(", ")}]::text[]`;
};

function apagadosNoLote(org: string, telefones: string[] | null): string[] {
  const bruto = sql(`select array_to_json(public.fn_titulares_apagados_a_pedido('${org}', ${lista(telefones)}))::text;`);
  const lido = JSON.parse(bruto) as string[];
  return [...lido].sort();
}

function apagadoUnitario(org: string, telefone: string): boolean {
  return sql(`select public.fn_titular_apagado_a_pedido('${org}', '${telefone}', null);`) === "t";
}

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values ('${MEMBRO_A}', 'lote-lgpd@invariant.test')
      on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'lote-lgpd-a', 'Lote A', 'Lote A'),
      ('${ORG_B}', 'lote-lgpd-b', 'Lote B', 'Lote B')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${MEMBRO_A}', '${ORG_A}', 'admin', now()) on conflict do nothing;
    insert into public.contacts (id, organization_id, name, phone_number) values
      ('${APAGADO}', '${ORG_A}', 'Titular Apagado', '+${TELEFONE}'),
      ('${NORMAL}', '${ORG_A}', 'Contato Normal', '+${OUTRO}'),
      ('${MESMO_NUMERO_EM_B}', '${ORG_B}', 'Mesmo número em B', '+${TELEFONE}')
      on conflict (id) do nothing;
  `);
  VARIANTES = JSON.parse(
    sql(`select array_to_json(public.fn_telefone_variantes('${TELEFONE}'))::text;`),
  ) as string[];
  sql(`select public.fn_lgpd_cascade_redact_contact('${ORG_A}', '${APAGADO}', gen_random_uuid());`);
});

describe("a agenda do app e o titular apagado a pedido", () => {
  it("depois da anonimização não sobra ficha viva com NENHUMA grafia do número", () => {
    // O número não existe mais em ficha viva — nem o principal, nem por extra.
    expect(
      sql(`
        select count(*) from public.contacts
         where organization_id = '${ORG_A}'
           and phone_number in (${[...VARIANTES.map((v) => `'${v}'`), comMais(TELEFONE)].join(", ")});
      `),
    ).toBe("0");
    expect(
      sql(`
        select count(*) from public.contact_phones
         where organization_id = '${ORG_A}'
           and phone_number in (${VARIANTES.map((v) => `'${v}'`).join(", ")});
      `),
    ).toBe("0");
    // E a ficha do titular continua lá, anonimizada e sem telefone: o que não
    // volta é o DADO, não o histórico.
    expect(
      sql(`
        select is_anonymized and phone_number is null
          from public.contacts where id = '${APAGADO}';
      `),
    ).toBe("t");
  });

  it("o lote responde sim para TODAS as grafias e NÃO para o contato normal", () => {
    expect(apagadosNoLote(ORG_A, [...VARIANTES, OUTRO])).toEqual([...VARIANTES].sort());
  });

  it("a resposta do lote é a MESMA da pergunta unitária, grafia por grafia", () => {
    const consultados = [...VARIANTES, OUTRO, "5519955554444"];
    const doLote = new Set(apagadosNoLote(ORG_A, consultados));
    for (const telefone of consultados) {
      expect(doLote.has(telefone)).toBe(apagadoUnitario(ORG_A, telefone));
    }
  });

  it("outra organização não herda a marca, e o lote de lá vem vazio", () => {
    expect(apagadosNoLote(ORG_B, [...VARIANTES, OUTRO])).toEqual([]);
    expect(apagadoUnitario(ORG_B, TELEFONE)).toBe(false);
  });

  it("lote vazio ou nulo devolve lista vazia, e a resposta é idempotente", () => {
    expect(apagadosNoLote(ORG_A, [])).toEqual([]);
    expect(apagadosNoLote(ORG_A, null)).toEqual([]);
    expect(apagadosNoLote(ORG_A, [TELEFONE])).toEqual(apagadosNoLote(ORG_A, [TELEFONE]));
  });

  it("só o servidor faz a pergunta do lote", () => {
    expect(
      sql(`
        select not has_function_privilege('anon', 'public.fn_titulares_apagados_a_pedido(uuid,text[])', 'EXECUTE')
           and not has_function_privilege('authenticated', 'public.fn_titulares_apagados_a_pedido(uuid,text[])', 'EXECUTE')
           and has_function_privilege('service_role', 'public.fn_titulares_apagados_a_pedido(uuid,text[])', 'EXECUTE');
      `),
    ).toBe("t");
    expect(() =>
      sql(`
        set role authenticated;
        select set_config('request.jwt.claims', '{"sub":"${MEMBRO_A}"}', false);
        select public.fn_titulares_apagados_a_pedido('${ORG_A}', array['${TELEFONE}']::text[]);
      `),
    ).toThrow(/permission denied/);
  });
});
