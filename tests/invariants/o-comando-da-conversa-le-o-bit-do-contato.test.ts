/**
 * O COMANDO DA CONVERSA LÊ O BIT DO CONTATO (#2739) — comportamento no banco.
 *
 * ─── O que mudou, e o que NÃO pode ter mudado ───────────────────────────────
 *
 * O campo calculado `comando_da_conversa(conversations)` resolvia
 * `contacts.force_human`/`is_blocked` com DUAS subconsultas POR LINHA. A 0645
 * move o que vem de outra tabela para a própria conversa
 * (`conversations.contato_trava_humano`), mantida por gatilho; a leitura
 * continua pela mesma função, com o mesmo contrato.
 *
 * Este arquivo mede o que o desenho do #1921 não podia congelar:
 *
 *   1. os DOIS gatilhos — o contato muda e a conversa muda junto; a conversa
 *      troca de contato e pega a trava do novo;
 *   2. o SILÊNCIO vencendo SEM escrita nenhuma — o prazo continua avaliado na
 *      CONSULTA, com `now()` de verdade;
 *   3. a definição EM VIGOR lê a coluna e não tem subconsulta a `contacts` — a
 *      prova estrutural de que o custo por linha saiu.
 *
 * O espelho TS×SQL (blocos A–D) continua em
 * `comando-da-conversa-espelha-o-ts.test.ts`, intocado: a regra `fn_` não mudou.
 */
import { describe, expect, it } from "vitest";

import { lastLine, sql } from "./gov-helpers";

const ORG = "aaaaaaaa-0000-4000-8000-00000000d101";
const SESS = "aaaaaaaa-0000-4000-8000-00000000d102";
const C1 = "aaaaaaaa-0000-4000-8000-00000000d1c1";
const C2 = "aaaaaaaa-0000-4000-8000-00000000d1c2";
const V1 = "aaaaaaaa-0000-4000-8000-00000000d1e1";
const V2 = "aaaaaaaa-0000-4000-8000-00000000d1e2";

/** Uma organização, sessão, dois contatos limpos e uma conversa apontando o C1. */
function semear() {
  sql(`
    delete from conversations where organization_id = '${ORG}';
    delete from contacts where organization_id = '${ORG}';
    delete from channel_sessions where organization_id = '${ORG}';
    delete from organizations where id = '${ORG}';
    insert into organizations (id, slug, legal_name, display_name)
      values ('${ORG}', 'bit-do-contato-2739', 'Bit LTDA', 'Bit');
    insert into channel_sessions (id, organization_id, webhook_secret_encrypted, waha_session_name)
      values ('${SESS}', '${ORG}', '\\x00', 'bit-2739');
    insert into contacts (id, organization_id, force_human, is_blocked)
      values ('${C1}', '${ORG}', false, false), ('${C2}', '${ORG}', false, false);
    insert into conversations (id, organization_id, contact_id, channel_session_id, status)
      values ('${V1}', '${ORG}', '${C1}', '${SESS}', 'open');
  `);
}

const comandoDaConversa = (id: string): string =>
  lastLine(
    sql(`select public.comando_da_conversa(c) from public.conversations c where c.id = '${id}'`),
  );

const bitDaConversa = (id: string): boolean =>
  lastLine(sql(`select c.contato_trava_humano::text from public.conversations c where c.id = '${id}'`)) ===
  "true";

describe("o comando da conversa lê o bit do contato (#2739)", () => {
  it("⭐ o contato muda force_human/is_blocked e a CONVERSA muda junto, sem tocá-la", () => {
    semear();
    expect(comandoDaConversa(V1), "contato limpo → automático").toBe("automatico");

    sql(`update public.contacts set force_human = true where id = '${C1}'`);
    expect(comandoDaConversa(V1), "force_human=true não chegou à conversa").toBe("aguardando");
    expect(bitDaConversa(V1)).toBe(true);

    sql(`update public.contacts set force_human = false, is_blocked = true where id = '${C1}'`);
    expect(comandoDaConversa(V1), "is_blocked=true não chegou à conversa").toBe("aguardando");
    expect(bitDaConversa(V1)).toBe(true);

    sql(`update public.contacts set is_blocked = false where id = '${C1}'`);
    expect(comandoDaConversa(V1), "o contato voltou limpo e a conversa ficou travada").toBe(
      "automatico",
    );
    expect(bitDaConversa(V1)).toBe(false);
  });

  it("⭐ trocar o CONTATO da conversa troca a trava junto (e a do anterior sai)", () => {
    semear();
    sql(`update public.contacts set force_human = true where id = '${C2}'`);

    sql(`update public.conversations set contact_id = '${C2}' where id = '${V1}'`);
    expect(comandoDaConversa(V1), "a conversa trocou para um contato travado e seguiu automática").toBe(
      "aguardando",
    );

    sql(`update public.conversations set contact_id = '${C1}' where id = '${V1}'`);
    expect(comandoDaConversa(V1), "a conversa voltou para o contato limpo e ficou travada").toBe(
      "automatico",
    );
  });

  it("⭐ o silêncio vence SEM escrita: a conversa muda de aba sozinha", () => {
    semear();
    sql(`
      insert into conversations (id, organization_id, contact_id, channel_session_id, status, bot_silenced_until)
        values ('${V2}', '${ORG}', '${C2}', '${SESS}', 'open', now() + interval '1 second')
    `);

    expect(comandoDaConversa(V2), "silêncio vigente → aguardando").toBe("aguardando");

    // O RELÓGIO passa, e NENHUMA linha é escrita no meio: é o que o desenho do
    // #1921 não sobrevivia (o comando ficava congelado na escrita).
    sql(`select pg_sleep(1.4)`);

    expect(comandoDaConversa(V2), "o silêncio venceu e a conversa ficou presa em aguardando").toBe(
      "automatico",
    );
  });

  it("a definição EM VIGOR lê a coluna e não tem subconsulta a contacts (prova estrutural)", () => {
    const definicao = sql(
      `select pg_get_functiondef('public.comando_da_conversa(public.conversations)'::regprocedure)`,
    );

    expect(definicao, "o wrapper deixou de ler o bit da linha").toContain("contato_trava_humano");
    expect(
      definicao,
      "voltou a resolver o contato por linha — o custo da issue #2739 de volta",
    ).not.toContain("from public.contacts");
    expect(definicao, "a decisão da 0404 (issue #1571) foi perdida").toContain("SECURITY DEFINER");
  });
});
