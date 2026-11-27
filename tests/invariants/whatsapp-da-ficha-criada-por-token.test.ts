import { beforeAll, describe, expect, it } from "vitest";

import { lastLine, sql } from "./gov-helpers";

/**
 * DES-1950 — A ficha criada por token nasce `phone_whatsapp = 'nao_sei'`, e a
 * mensagem RECEBIDA pelo WhatsApp continua marcando `'sim'`.
 *
 * ═══ O que se mede aqui, e por que com Postgres de verdade ═══
 *
 * `openSharedContactConversation` (rota `open-with-contact`, tool MCP
 * `crm_start_conversation_and_send`, `POST /messages` por telefone) deixou de
 * criar a ficha pela RPC do webhook e passou a fazer o INSERT que este arquivo
 * repete, com as MESMAS colunas e como `service_role`. O dublê de
 * `lib/messaging/open-shared-contact-conversation.whatsapp.test.ts` prova que a
 * função manda esse INSERT; o que ele não prova é que o banco o aceita (CHECK,
 * gatilho "um número, uma ficha", grants) e que a regra do webhook continua de
 * pé depois dele. Essas são as perguntas deste arquivo.
 *
 * ═══ Os lados ═══
 *
 * - ⭐ a ficha do INSERT por token nasce `nao_sei` (ou o valor informado);
 * - não regressão: a mesma ficha, quando o número ESCREVE pelo WhatsApp
 *   (`fn_upsert_wa_contact`, o upsert do webhook), vira `sim`;
 * - controle: número novo que chega pelo webhook nasce `sim`, como sempre.
 */

const ORG = "d1950000-0000-4000-8000-000000000001";
const TEL_NAO_SEI = "+5531900019501";
const TEL_NAO = "+5531900019502";
const TEL_WEBHOOK = "+5531900019503";

/** O INSERT de `resolveContactId` (lib/messaging/open-shared-contact-conversation.ts). */
function criarPorToken(telefone: string, whatsapp: string | null): string {
  const valor = whatsapp === null ? "null" : `'${whatsapp}'`;
  const saida = sql(`
    set role service_role;
    with nova as (insert into public.contacts
      (organization_id, phone_number, phone_whatsapp, source, display_name)
    values ('${ORG}', '${telefone}', coalesce(${valor}, 'nao_sei'), 'whatsapp', 'Quem ligou')
    returning id)
    select id from nova;
  `);
  return lastLine(saida);
}

/** O que o webhook faz quando o número escreve: o upsert por telefone. */
function chegouPeloWhatsapp(telefone: string): string {
  return lastLine(
    sql(`
      set role service_role;
      select public.fn_upsert_wa_contact(
        '${ORG}'::uuid, 'phone', '${telefone}', null, '${telefone.replace(/\D/g, "")}', 'Cliente');
    `),
  );
}

function whatsappDa(id: string): string {
  return lastLine(sql(`select phone_whatsapp from public.contacts where id = '${id}';`));
}

beforeAll(() => {
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG}', 'whatsapp-1950', 'WhatsApp 1950', 'WhatsApp 1950')
      on conflict do nothing;
  `);
});

describe("WhatsApp da ficha criada por token (DES-1950)", () => {
  it("⭐ a ficha criada por token nasce `nao_sei`, e vira `sim` quando o número escreve pelo WhatsApp", () => {
    const id = criarPorToken(TEL_NAO_SEI, null);
    expect(whatsappDa(id)).toBe("nao_sei");

    // Não regressão: a mensagem RECEBIDA acha a MESMA ficha e marca `sim`.
    expect(chegouPeloWhatsapp(TEL_NAO_SEI)).toBe(id);
    expect(whatsappDa(id)).toBe("sim");
  });

  it("o valor que quem chama informa é o que a ficha grava", () => {
    const id = criarPorToken(TEL_NAO, "nao");
    expect(whatsappDa(id)).toBe("nao");
  });

  it("controle: número novo que chega pelo webhook continua nascendo `sim`", () => {
    const id = chegouPeloWhatsapp(TEL_WEBHOOK);
    expect(whatsappDa(id)).toBe("sim");
  });
});
