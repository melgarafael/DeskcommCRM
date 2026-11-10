/**
 * APAGAR O CONTATO NÃO APAGA O RECEBIMENTO PAGO (migration 9312, #3509).
 *
 * `fn_apagar_contato_com_historico` apaga as conversas do contato. O
 * recebimento registrado numa delas fica, com `conversation_id` nulo e valor,
 * status e `pago_em` preservados — `on delete set null`, o mesmo critério do
 * `orders.contact_id`. E quem enxerga a organização continua lendo a linha:
 * sem conversa, a policy de leitura é só da organização.
 *
 * Tudo numa transação desfeita no fim: o arquivo não deixa linha para trás.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { GOV_ORG, GOV_SESSION, GOV_VIEWER, seedGov, sql } from "./gov-helpers";

const CONTATO = "cccccccc-9312-4000-8000-000000000001";
const CONVERSA = "cccccccc-9312-4000-8000-000000000002";
const RECEBIMENTO = "cccccccc-9312-4000-8000-000000000003";
const ESTRANHO = "cccccccc-9312-4000-8000-0000000000ff";

beforeAll(() => {
  seedGov();
});

/** Lê `rotulo=valor` das linhas do psql -tA. */
function medida(saida: string, rotulo: string): string | undefined {
  return saida
    .split("\n")
    .find((l) => l.startsWith(`${rotulo}=`))
    ?.slice(rotulo.length + 1);
}

describe("pagamento_recebimentos: o recebimento sobrevive à conversa apagada", () => {
  it("apagar o contato deixa o recebimento pago com conversation_id nulo, e a organização ainda o lê", () => {
    const saida = sql(`
      begin;
      insert into public.contacts (id, organization_id, display_name)
        values ('${CONTATO}', '${GOV_ORG}', 'Contato do recebimento 9312');
      insert into public.conversations (id, organization_id, contact_id, channel_session_id, status)
        values ('${CONVERSA}', '${GOV_ORG}', '${CONTATO}', '${GOV_SESSION}', 'open');
      insert into public.pagamento_recebimentos
        (id, organization_id, conversation_id, provedor, aviso_token_hash, valor_cents, status, pago_em, external_id)
      values ('${RECEBIMENTO}', '${GOV_ORG}', '${CONVERSA}', 'infinitepay',
              encode(sha256(convert_to('recebimento-9312', 'UTF8')), 'hex'), 15000, 'paga', now(), 'slug-9312');

      select 'antes=' || coalesce(conversation_id::text, 'nulo')
        from public.pagamento_recebimentos where id = '${RECEBIMENTO}';

      select 'apagou=' || public.fn_apagar_contato_com_historico('${CONTATO}', '${GOV_ORG}')::text;

      select 'conversa=' || count(*) from public.conversations where id = '${CONVERSA}';
      select 'depois=' || coalesce(
        (select coalesce(conversation_id::text, 'nulo') || '|' || status || '|' || valor_cents || '|' || (pago_em is not null)
           from public.pagamento_recebimentos where id = '${RECEBIMENTO}'),
        'sumiu');

      set local role authenticated;
      select 'claims=' || set_config('request.jwt.claims', '{"sub":"${GOV_VIEWER}"}', true);
      select 'membro_le=' || count(*) from public.pagamento_recebimentos where id = '${RECEBIMENTO}';
      select 'claims=' || set_config('request.jwt.claims', '{"sub":"${ESTRANHO}"}', true);
      select 'estranho_le=' || count(*) from public.pagamento_recebimentos where id = '${RECEBIMENTO}';
      rollback;
    `);

    // Controle: antes de apagar, o recebimento estava preso à conversa.
    expect(medida(saida, "antes")).toBe(CONVERSA);
    expect(medida(saida, "apagou")).toBe("true");
    expect(medida(saida, "conversa"), "a conversa saiu com o contato").toBe("0");
    expect(medida(saida, "depois"), "o recebimento pago fica, sem conversa").toBe("nulo|paga|15000|true");
    expect(medida(saida, "membro_le"), "quem é da organização lê o recebimento sem conversa").toBe("1");
    expect(medida(saida, "estranho_le"), "quem não é da organização não lê").toBe("0");
  });

  it("o FK da conversa é `on delete set null` e a coluna aceita nulo", () => {
    expect(
      sql(`
        select c.confdeltype || '|' || a.attnotnull
          from pg_constraint c
          join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
         where c.conrelid = 'public.pagamento_recebimentos'::regclass
           and c.contype = 'f'
           and c.confrelid = 'public.conversations'::regclass;
      `),
    ).toBe("n|false");
  });
});
