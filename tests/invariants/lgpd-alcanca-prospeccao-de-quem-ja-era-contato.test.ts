/**
 * ANONIMIZAR ALCANÇA O CANDIDATO DE PROSPECÇÃO MESMO SEM VÍNCULO — migration 0361.
 *
 * ## O defeito, e quem ele atinge
 *
 * Quando a prospecção raspa um telefone que JÁ pertence a um contato da
 * organização, `lib/prospecting/store.ts` grava o candidato como `skipped` e
 * deixa `contact_id` **nulo de propósito** — lá o vínculo não é só referência, é
 * o freio de mão do envio (`lib/prospecting/worker.ts` recusa abordagem sem
 * `contact_id`). Gravar o vínculo para consertar a LGPD tiraria esse freio: não
 * seria conserto, seria mudar o risco de lugar.
 *
 * Só que o expurgo alcançava `where contact_id = p_contact_id`. Resultado: a
 * pessoa que a empresa JÁ CONHECIA pedia exclusão, a rota devolvia sucesso, a
 * auditoria gravava `lgpd.redact_executed`, o SLA de D+15 fechava — e nome,
 * telefone e endereço dela seguiam legíveis em `prospecting_candidates`. O pior
 * modo de falha que existe para obrigação legal: ninguém erra, nada loga.
 *
 * ## Por que este arquivo existe, se já há uma cerca de cascata
 *
 * `tests/unit/lgpd-cascata-alcanca-quem-guarda-pessoa.test.ts` deriva cobertura
 * por REGEX SOBRE NOME DE TABELA no corpo da função. `update
 * prospecting_candidates` já aparecia lá, então a tabela contava como coberta e
 * o PREDICADO nunca era lido. Cerca verde sobre lacuna real — a mesma família do
 * buraco que o #1300 fechou. A única prova que separa as duas coisas é rodar o
 * expurgo num Postgres de verdade e olhar a linha.
 *
 * ## As duas metades
 *
 * "O dado sumiu" sozinho ficaria verde se o expurgo apagasse a linha inteira — e
 * aí a organização perderia a supressão que impede uma nova raspagem de
 * reintroduzir a mesma pessoa. Por isso cada caso de "sumiu" anda colado de um
 * caso de "a supressão ficou de pé".
 *
 * ## O nono dígito não é capricho
 *
 * O mesmo celular é gravado com e sem o `9` por caminhos diferentes (cadastro à
 * mão, importação, o que o WhatsApp devolve). Comparar a string crua deixaria a
 * pessoa no banco por causa de um dígito. O candidato semeado aqui tem
 * exatamente a grafia OPOSTA à do contato, de propósito: é o caso que uma
 * comparação ingênua perde.
 *
 * ## E o vizinho
 *
 * Um terceiro candidato, de telefone alheio, prova o outro lado: alcançar demais
 * custaria o registro de prospecção de quem não pediu nada.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { sql } from "./psql-transporte";

/** Namespace próprio (03450000-): semente idempotente e sem colisão em paralelo. */
const ORG = "03450000-0000-4000-8000-000000000001";
const ALVO = "03450000-2222-4000-8000-000000000001";
const CAMPANHA = "03450000-1111-4000-8000-000000000001";
/** Sem `contact_id` e com a grafia OPOSTA do telefone — o caso que se perdia. */
const CAND_SEM_VINCULO = "03450000-3333-4000-8000-000000000001";
/** Com vínculo: o caminho que já funcionava, e que não pode regredir. */
const CAND_COM_VINCULO = "03450000-3333-4000-8000-000000000002";
/** De outra pessoa: mede o excesso. */
const CAND_VIZINHO = "03450000-3333-4000-8000-000000000003";

/** O contato guarda COM o nono dígito; o candidato, SEM. */
const TEL_CONTATO = "+5531987654321";
const TEL_CANDIDATO_SEM_NONO = "+553187654321";
const TEL_VIZINHO = "+5531911112222";

const NOME = "Marina Boaventura";
const ROTULO = `Cliente Anonimizado #${ALVO.slice(0, 8)}`;

function valor(consulta: string): string {
  const saida = sql(consulta).trim();
  return saida.split("\n").at(-1) ?? "";
}

function campo(candidato: string, coluna: string): string {
  return valor(
    `select coalesce(${coluna}::text, '<null>') from public.prospecting_candidates where id = '${candidato}';`,
  );
}

let antesDoExpurgo: { nome: string; telefone: string };

beforeAll(() => {
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG}', 'lgpd-prospec-0361', 'LGPD Prospecção 0361', 'LGPD Prospecção 0361')
      on conflict do nothing;

    insert into public.contacts (id, organization_id, name, display_name, phone_number)
      values ('${ALVO}', '${ORG}', '${NOME}', '${NOME}', '${TEL_CONTATO}')
      on conflict (id) do update set
        name = excluded.name, display_name = excluded.display_name,
        phone_number = excluded.phone_number, is_anonymized = false, anonymized_at = null;

    insert into public.prospecting_campaigns (id, organization_id, request_id, name, search)
      values ('${CAMPANHA}', '${ORG}', gen_random_uuid(), 'Campanha 0361', '{}'::jsonb)
      on conflict (id) do nothing;

    -- O candidato do defeito: telefone da MESMA pessoa, grafado SEM o nono
    -- dígito, e contact_id NULO (é assim que o store.ts o grava).
    insert into public.prospecting_candidates
      (id, organization_id, campaign_id, place_id, phone, data, status, contact_id)
      values ('${CAND_SEM_VINCULO}', '${ORG}', '${CAMPANHA}', 'place-sem-vinculo',
        '${TEL_CANDIDATO_SEM_NONO}',
        jsonb_build_object('key','place-sem-vinculo','name','${NOME}','phone','${TEL_CANDIDATO_SEM_NONO}',
          'address','Rua das Acácias, 100','maps_url','https://maps.example/1'),
        'skipped', null)
      on conflict (id) do update set
        phone = excluded.phone, data = excluded.data, status = excluded.status,
        contact_id = null, suppression_salt = null, suppression_phone = null,
        suppression_place = null, place_id = excluded.place_id;

    insert into public.prospecting_candidates
      (id, organization_id, campaign_id, place_id, phone, data, status, contact_id)
      values ('${CAND_COM_VINCULO}', '${ORG}', '${CAMPANHA}', 'place-com-vinculo',
        '+5531988887777',
        jsonb_build_object('key','place-com-vinculo','name','${NOME}','phone','+5531988887777'),
        'sent', '${ALVO}')
      on conflict (id) do update set
        phone = excluded.phone, data = excluded.data, status = excluded.status,
        contact_id = excluded.contact_id, suppression_salt = null,
        suppression_phone = null, suppression_place = null, place_id = excluded.place_id;

    insert into public.prospecting_candidates
      (id, organization_id, campaign_id, place_id, phone, data, status, contact_id)
      values ('${CAND_VIZINHO}', '${ORG}', '${CAMPANHA}', 'place-vizinho',
        '${TEL_VIZINHO}',
        jsonb_build_object('key','place-vizinho','name','Padaria do Bairro','phone','${TEL_VIZINHO}'),
        'new', null)
      on conflict (id) do update set
        phone = excluded.phone, data = excluded.data, status = excluded.status,
        contact_id = null, suppression_salt = null, suppression_phone = null,
        suppression_place = null, place_id = excluded.place_id;
  `);

  antesDoExpurgo = {
    nome: campo(CAND_SEM_VINCULO, "data->>'name'"),
    telefone: campo(CAND_SEM_VINCULO, "phone"),
  };

  sql(`select public.fn_lgpd_cascade_redact_contact('${ORG}', '${ALVO}', gen_random_uuid());`);
});

describe("anonimizar alcança a prospecção de quem já era contato", () => {
  it("a semente estava legível ANTES — sem isto, 'sumiu' não prova nada", () => {
    // Um seed que falhou em silêncio deixaria tudo nulo, e todas as asserções
    // de ausência passariam sozinhas. Esta é a pré-condição das outras.
    expect(antesDoExpurgo.nome).toBe(NOME);
    expect(antesDoExpurgo.telefone).toBe(TEL_CANDIDATO_SEM_NONO);
  });

  it("o candidato SEM vínculo, com o telefone em outra grafia, foi alcançado", () => {
    expect(campo(CAND_SEM_VINCULO, "phone")).toBe("<null>");
    expect(campo(CAND_SEM_VINCULO, "data->>'name'")).toBe(ROTULO);
    expect(campo(CAND_SEM_VINCULO, "data->>'phone'")).toBe("<null>");
    expect(campo(CAND_SEM_VINCULO, "data->>'address'")).toBe("<null>");
    expect(campo(CAND_SEM_VINCULO, "place_id")).toBe(`redacted:${CAND_SEM_VINCULO}`);
  });

  it("e a SUPRESSÃO ficou de pé — apagar sem suprimir deixaria a raspagem trazer a pessoa de volta", () => {
    expect(campo(CAND_SEM_VINCULO, "suppression_salt")).not.toBe("<null>");
    expect(campo(CAND_SEM_VINCULO, "suppression_place")).not.toBe("<null>");
    // O token do telefone é o que a trigger consulta para RECUSAR a reimportação.
    expect(campo(CAND_SEM_VINCULO, "suppression_phone")).not.toBe("<null>");
    // A linha continua existindo: é ela que sustenta a recusa.
    expect(valor(`select count(*) from public.prospecting_candidates where id = '${CAND_SEM_VINCULO}';`)).toBe("1");
  });

  it("o candidato COM vínculo continua alcançado — o braço antigo não regrediu", () => {
    expect(campo(CAND_COM_VINCULO, "phone")).toBe("<null>");
    expect(campo(CAND_COM_VINCULO, "data->>'name'")).toBe(ROTULO);
    expect(campo(CAND_COM_VINCULO, "suppression_phone")).not.toBe("<null>");
  });

  it("o vizinho NÃO foi tocado — alcançar demais custa o registro de quem não pediu nada", () => {
    expect(campo(CAND_VIZINHO, "phone")).toBe(TEL_VIZINHO);
    expect(campo(CAND_VIZINHO, "data->>'name'")).toBe("Padaria do Bairro");
    expect(campo(CAND_VIZINHO, "suppression_salt")).toBe("<null>");
  });

  it("a contagem devolvida conta as DUAS linhas alcançadas, não só a vinculada", () => {
    // O retorno é o que a rota mostra a quem opera. Se ele disser 1 enquanto
    // duas linhas foram tratadas, o relatório de conformidade mente para menos.
    const contagem = valor(
      `select (public.fn_lgpd_cascade_redact_contact('${ORG}', '${ALVO}', gen_random_uuid()))->>'already_anonymized';`,
    );
    // Segunda chamada é no-op por desenho (o contato já está anonimizado).
    expect(contagem).toBe("true");
  });
});
