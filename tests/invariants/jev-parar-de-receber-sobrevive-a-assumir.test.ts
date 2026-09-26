/**
 * O AVISO DE PARAR DE RECEBER NÃO SOME AO ASSUMIR (migration 0426, parte 3 —
 * o conserto 3 da onda 3 do Jev).
 *
 * O aviso de parar de receber manda a equipe fazer DOIS passos: assumir a
 * conversa (o assistente para de responder) e pedir ao cliente que responda
 * PARAR — que é o que de fato bloqueia o contato (`lib/ai/decisao/pedidos.ts`,
 * `AVISOS_DOS_PEDIDOS.opt_out`). Fechá-lo no primeiro passo sumia com o
 * lembrete de um pedido de descadastro (um direito do titular) antes do passo
 * que o atende: se ninguém pedisse o PARAR, o contato seguia recebendo
 * campanha e follow-up, e já não havia nada aberto na Central.
 *
 * Então, pelo gatilho `trg_fechar_avisos_do_jev_da_conversa`:
 *  - assumir (o `fn_conversation_assign` que o "Assumir" da tela chama) e a
 *    passagem a uma pessoa fecham SÓ o de falar com uma pessoa;
 *  - a conversa encerrada fecha os dois;
 *  - o contato bloqueado segue fechando o de parar de receber (o outro gatilho).
 *
 * ⚠️ Contradiz, de propósito, o caso CONGELADO
 * `tests/invariants/jev-aviso-na-central.test.ts` — "uma pessoa assume a
 * conversa: os avisos do Jev DELA fecham; o handoff e a vizinha ficam" —, que
 * espera `jev_parar_de_receber=resolved+fim` depois de assumir. O congelamento
 * (`loop/hooks/freeze-invariants.sh`) não tem válvula para esta mudança; o
 * caso antigo é a sobra declarada do PR.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { GOV_AGENT_A, GOV_CONV_CLAIM, GOV_CONV_UNASSIGNED, GOV_ORG, seedGov, sql } from "./gov-helpers";

const KINDS = ["jev_pedido_de_humano", "jev_parar_de_receber"] as const;

function abrir(kind: string, conversa: string): void {
  sql(`insert into public.agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id)
       values ('${GOV_ORG}', '${kind}', 'warn', 'Um cliente parece pedir', 'corpo', 'conversation', '${conversa}');`);
}

/** `kind=status` (e `+fim` quando `resolved_at` foi preenchido), em ordem de kind. */
function avisosDa(conversa: string): string[] {
  const saida = sql(`select kind || '=' || status || case when resolved_at is not null then '+fim' else '' end
                       from public.agent_inbox_items
                      where organization_id = '${GOV_ORG}' and ref_id = '${conversa}'
                      order by kind;`);
  return saida === "" ? [] : saida.split("\n");
}

function limpar(): void {
  sql(`delete from public.agent_inbox_items where organization_id = '${GOV_ORG}';
       update public.conversations
          set assigned_to_user_id = null, assigned_at = null, assignee_kind = null, status = 'open',
              bot_silenced_until = null, last_handoff_at = null
        where id in ('${GOV_CONV_UNASSIGNED}', '${GOV_CONV_CLAIM}');
       update public.contacts set is_blocked = false
        where id in (select contact_id from public.conversations where id = '${GOV_CONV_UNASSIGNED}');
       delete from public.agent_inbox_items where organization_id = '${GOV_ORG}';`);
}

/** O que o "Assumir" da tela faz (`app/api/v1/conversations/[id]/claim/route.ts`). */
function assumir(conversa: string): void {
  sql(`select count(*) from public.fn_conversation_assign('${GOV_ORG}', '${conversa}', '${GOV_AGENT_A}', 'claim', null, true);`);
  // Controle: assumiu de verdade (a função devolve vazio, sem erro, quando não assume).
  expect(sql(`select assigned_to_user_id || '/' || status from public.conversations where id = '${conversa}';`)).toBe(
    `${GOV_AGENT_A}/claimed`,
  );
}

beforeAll(() => seedGov());

describe("o aviso de parar de receber segue aberto até o PARAR, o encerramento ou 'Marcar resolvido'", () => {
  it("assumir pela tela: fecha o de falar com uma pessoa, e o de parar de receber fica — só o da conversa certa", () => {
    limpar();
    for (const kind of KINDS) abrir(kind, GOV_CONV_UNASSIGNED);
    abrir("jev_pedido_de_humano", GOV_CONV_CLAIM);

    assumir(GOV_CONV_UNASSIGNED);

    expect(avisosDa(GOV_CONV_UNASSIGNED)).toEqual(["jev_parar_de_receber=open", "jev_pedido_de_humano=resolved+fim"]);
    expect(avisosDa(GOV_CONV_CLAIM), "a vizinha fica").toEqual(["jev_pedido_de_humano=open"]);
  });

  it("a passagem do turno e, depois, alguém assume: o de parar de receber segue aberto nos dois passos", () => {
    limpar();
    for (const kind of KINDS) abrir(kind, GOV_CONV_UNASSIGNED);
    // A escrita de `performHumanHandoff` (lib/agent-engine/agent/human-handoff.ts).
    sql(`update public.conversations
            set status = case when status = 'ai_handling' then 'pending' else status end,
                bot_silenced_until = 'infinity', last_handoff_at = now(), last_handoff_reason = 'pedido explícito',
                active_ai_agent_id = null, active_intent = null, active_agent_set_at = null
          where organization_id = '${GOV_ORG}' and id = '${GOV_CONV_UNASSIGNED}';`);
    expect(avisosDa(GOV_CONV_UNASSIGNED)).toEqual(["jev_parar_de_receber=open", "jev_pedido_de_humano=resolved+fim"]);

    assumir(GOV_CONV_UNASSIGNED);
    expect(avisosDa(GOV_CONV_UNASSIGNED)).toEqual(["jev_parar_de_receber=open", "jev_pedido_de_humano=resolved+fim"]);
  });

  it("a conversa encerrada fecha os dois — também depois de assumida", () => {
    limpar();
    for (const kind of KINDS) abrir(kind, GOV_CONV_UNASSIGNED);
    assumir(GOV_CONV_UNASSIGNED);
    expect(avisosDa(GOV_CONV_UNASSIGNED), "assumida, o de parar de receber segue (controle)").toContain(
      "jev_parar_de_receber=open",
    );

    sql(`update public.conversations set status = 'closed' where id = '${GOV_CONV_UNASSIGNED}';`);
    expect(avisosDa(GOV_CONV_UNASSIGNED)).toEqual(["jev_parar_de_receber=resolved+fim", "jev_pedido_de_humano=resolved+fim"]);
  });

  it("o contato bloqueado (o PARAR que a equipe pediu) fecha o de parar de receber da conversa assumida", () => {
    limpar();
    abrir("jev_parar_de_receber", GOV_CONV_UNASSIGNED);
    assumir(GOV_CONV_UNASSIGNED);
    expect(avisosDa(GOV_CONV_UNASSIGNED)).toEqual(["jev_parar_de_receber=open"]);

    sql(`update public.contacts set is_blocked = true
          where organization_id = '${GOV_ORG}'
            and id = (select contact_id from public.conversations where id = '${GOV_CONV_UNASSIGNED}');`);
    expect(avisosDa(GOV_CONV_UNASSIGNED)).toEqual(["jev_parar_de_receber=resolved+fim"]);
  });
});
