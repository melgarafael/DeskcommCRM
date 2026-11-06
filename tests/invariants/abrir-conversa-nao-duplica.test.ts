import { beforeAll, describe, expect, it } from "vitest";

import { lastLine, sql } from "./gov-helpers";

/**
 * #3483 — "Salvar e iniciar conversa" NÃO pode abrir uma segunda conversa.
 *
 * ═══ O que se mede aqui, e por que com Postgres de verdade ═══
 *
 * O botão do cadastro de contato e de negócio abre a conversa pela porta única
 * do Inbox (`openSharedContactConversation` → `fn_service_begin`). Quem clica
 * duas vezes — o gesto natural de quem está ansioso pelo cadastro novo — ou
 * volta ao mesmo contato dias depois não pode ganhar duas threads: a conversa
 * É o thread com aquele contato naquele número, e duas linhas abertas seriam
 * dois atendimentos para a mesma pessoa.
 *
 * O dublê de `lib/messaging/open-shared-contact-conversation.test.ts` prova que
 * a função delega UMA vez, com a mesma chave, e não insere nada por conta
 * própria. O que ele não pode provar é o desfecho no banco: que essa chave
 * devolve a mesma linha em vez de estourar o índice único ou criar outra. Essa
 * é a pergunta deste arquivo.
 *
 * ═══ Os dois lados ═══
 *
 * - o caso ⭐: duas aberturas no mesmo contato e canal → um id, uma linha;
 * - o controle: contato fechado reabre em vez de duplicar (é o que impede o
 *   23505 de matar o envio automatizado para sempre — o índice é único por
 *   contato e sessão SEM filtro de status);
 * - o controle negativo: OUTRA sessão é OUTRA conversa. Sem ele, um
 *   `fn_service_begin` que ignorasse `p_session` passaria nos casos ⭐ e de
 *   reabertura, e o teste ficaria verde escondendo o defeito oposto.
 */

const ORG = "c3483000-0000-4000-8000-000000000001";
const SESSAO = "c3483000-2222-4000-8000-000000000001";
const SESSAO_B = "c3483000-2222-4000-8000-000000000002";
const CONTATO = "c3483000-3333-4000-8000-000000000001";
const CONTATO_SEM_HISTORICO = "c3483000-3333-4000-8000-000000000002";

/** Uma chamada de `fn_service_begin` como o service role — como a rota faz. */
function abrir(contato: string, sessao: string): string {
  const saida = sql(`
    set role service_role;
    select public.fn_service_begin(
      '${ORG}'::uuid, '${contato}'::uuid, '${sessao}'::uuid);
  `);
  return (JSON.parse(lastLine(saida)) as { conversation_id: string }).conversation_id;
}

/** Quantas conversas NÃO-grupo aquele contato tem, em qualquer status. */
function conversasDo(contato: string): number {
  return Number(
    lastLine(
      sql(`select count(*) from public.conversations
           where organization_id = '${ORG}' and contact_id = '${contato}' and not is_group;`),
    ),
  );
}

function statusDe(conversaId: string): string {
  return lastLine(sql(`select status from public.conversations where id = '${conversaId}';`));
}

beforeAll(() => {
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG}', 'abrir-3483', 'Abrir 3483', 'Abrir 3483')
      on conflict do nothing;

    do $s$ begin
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
        values ('${SESSAO}', '${ORG}', 'abrir-3483-a', '\\x00'::bytea),
               ('${SESSAO_B}', '${ORG}', 'abrir-3483-b', '\\x00'::bytea);
    exception when unique_violation then null; end $s$;

    insert into public.contacts (id, organization_id, display_name, phone_number)
      values ('${CONTATO}', '${ORG}', 'Contato 3483', '+5531900003481'),
             ('${CONTATO_SEM_HISTORICO}', '${ORG}', 'Contato 3483 B', '+5531900003482')
      on conflict do nothing;
  `);
});

describe("abrir a conversa de novo devolve a existente, nunca uma segunda (#3483)", () => {
  it("⭐ duas aberturas do MESMO contato no MESMO canal: um id, uma linha", () => {
    const primeira = abrir(CONTATO, SESSAO);
    const segunda = abrir(CONTATO, SESSAO);

    expect(segunda).toBe(primeira);
    expect(conversasDo(CONTATO)).toBe(1);
  });

  it("conversa fechada é REABERTA, e não duplicada", () => {
    // O índice único é por contato e sessão SEM filtro de status: um INSERT
    // novo estouraria 23505 e o envio automatizado falharia para sempre.
    const conversa = abrir(CONTATO, SESSAO);
    sql(`update public.conversations set status = 'closed' where id = '${conversa}';`);
    expect(statusDe(conversa)).toBe("closed");

    const reaberta = abrir(CONTATO, SESSAO);

    expect(reaberta).toBe(conversa);
    expect(statusDe(reaberta)).toBe("open");
    expect(conversasDo(CONTATO)).toBe(1);
  });

  it("controle negativo: OUTRA sessão é OUTRA conversa", () => {
    const conversa = abrir(CONTATO_SEM_HISTORICO, SESSAO);
    const outra = abrir(CONTATO_SEM_HISTORICO, SESSAO_B);

    expect(outra).not.toBe(conversa);
    expect(conversasDo(CONTATO_SEM_HISTORICO)).toBe(2);
  });
});
