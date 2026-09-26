/**
 * O AVISO DO JEV NA CENTRAL, NO BANCO QUE O KIT INSTALA (migration 0426).
 *
 * Em "Avisar a equipe", o Jev abre na Central um aviso por conversa e pedido
 * (`lib/ai/decisao/pedidos.ts`), com um kind próprio. Duas coisas moram no banco
 * e só um Postgres real prova:
 *
 *  1. O CHECK de `agent_inbox_items.kind` aceita os dois kinds. Sem eles, o
 *     insert do gravador é recusado num caminho que só loga — o aviso nunca
 *     aparece, e nada fica vermelho.
 *  2. O aviso FECHA pelo gatilho da 0426 (`trg_fechar_avisos_do_jev_da_conversa`),
 *     e só o da conversa certa: o `handoff` da mesma conversa e o aviso da
 *     vizinha ficam. Uma pessoa assumir fecha SÓ o de falar com uma pessoa — o
 *     de parar de receber pede à equipe assumir E pedir o PARAR, e segue aberto
 *     (`jev-parar-de-receber-sobrevive-a-assumir.test.ts`); a conversa encerrada
 *     fecha. E a IA seguir atendendo (`ai_handling`) não fecha nada.
 *
 * Pelo SQL que o gravador escreve, e pelo `update` que a atribuição faz.
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
       update public.conversations set assigned_to_user_id = null, assignee_kind = null, status = 'open'
        where id in ('${GOV_CONV_UNASSIGNED}', '${GOV_CONV_CLAIM}');
       delete from public.agent_inbox_items where organization_id = '${GOV_ORG}';`);
}

beforeAll(() => seedGov());

describe("o aviso do Jev na Central", () => {
  it("o banco aceita os dois kinds — e segue recusando um inventado", () => {
    limpar();
    for (const kind of KINDS) abrir(kind, GOV_CONV_UNASSIGNED);
    expect(avisosDa(GOV_CONV_UNASSIGNED)).toEqual(["jev_parar_de_receber=open", "jev_pedido_de_humano=open"]);
    expect(() => abrir("jev_pedido_inventado", GOV_CONV_UNASSIGNED)).toThrow(/agent_inbox_items_kind_check/);
  });

  it("uma pessoa assume a conversa: o aviso de falar com uma pessoa DELA fecha; o de parar de receber, o handoff e a vizinha ficam", () => {
    limpar();
    for (const kind of KINDS) abrir(kind, GOV_CONV_UNASSIGNED);
    abrir("handoff", GOV_CONV_UNASSIGNED);
    abrir("jev_pedido_de_humano", GOV_CONV_CLAIM);

    sql(`update public.conversations
            set assigned_to_user_id = '${GOV_AGENT_A}', assignee_kind = 'user', status = 'claimed'
          where id = '${GOV_CONV_UNASSIGNED}';`);

    expect(avisosDa(GOV_CONV_UNASSIGNED)).toEqual([
      "handoff=open",
      "jev_parar_de_receber=open",
      "jev_pedido_de_humano=resolved+fim",
    ]);
    expect(avisosDa(GOV_CONV_CLAIM)).toEqual(["jev_pedido_de_humano=open"]);
  });

  it("a conversa encerrada fecha o aviso; a IA seguir atendendo não fecha nada", () => {
    limpar();
    abrir("jev_parar_de_receber", GOV_CONV_CLAIM);

    // A IA continua com a conversa: ninguém assumiu, o aviso segue valendo.
    sql(`update public.conversations set status = 'ai_handling' where id = '${GOV_CONV_CLAIM}';`);
    expect(avisosDa(GOV_CONV_CLAIM)).toEqual(["jev_parar_de_receber=open"]);

    sql(`update public.conversations set status = 'closed' where id = '${GOV_CONV_CLAIM}';`);
    expect(avisosDa(GOV_CONV_CLAIM)).toEqual(["jev_parar_de_receber=resolved+fim"]);
  });
});
