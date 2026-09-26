/**
 * O AVISO DO JEV NA CENTRAL FECHA SOZINHO, E É UM SÓ (migration 0426, partes 2
 * e 3 — o conserto da revisão da onda 3).
 *
 * O CHECK dos dois kinds e o fechamento quando uma pessoa assume ou a conversa
 * é encerrada estão em `jev-aviso-na-central.test.ts` (quem fecha é
 * `trg_fechar_avisos_do_jev_da_conversa`, o gatilho próprio da 0426; assumir
 * fecha só o de falar com uma pessoa). Aqui, o que só um Postgres real prova
 * do resto:
 *
 *  1. O aviso FECHA quando o pedido foi atendido por qualquer caminho, e só o
 *     da conversa certa: a conversa PASSADA a uma pessoa (a escrita do
 *     `performHumanHandoff`, do orquestrador do clima, da pausa manual — que
 *     nem toca no status) fecha o de falar com uma pessoa; o contato bloqueado
 *     fecha o de parar de receber, de todas as conversas dele.
 *  2. UM aviso por conversa e pedido: o índice único parcial, sem status. O
 *     segundo insert volta 23505 — é o sinal com que o gravador
 *     (`lib/ai/decisao/pedidos.ts`) REABRE o aviso que existe — e um clone com
 *     repetidos (quem rodou o PR antes do conserto) não quebra no `update.sh`:
 *     a migration os tira antes de criar o índice.
 *
 * Pelos `update`s que cada caminho faz, copiados de onde eles moram.
 */
import { readFileSync } from "node:fs";

import { beforeAll, describe, expect, it } from "vitest";

import { GOV_CONV_CLAIM, GOV_CONV_UNASSIGNED, GOV_ORG, GOV_SESSION, seedGov, sql } from "./gov-helpers";

const KINDS = ["jev_pedido_de_humano", "jev_parar_de_receber"] as const;

/**
 * Um contato só deste arquivo, com duas conversas — o bloqueio vale para o
 * contato inteiro. Em dois números: uma conversa por contato e número é regra
 * do banco, e a segunda no mesmo número não nasceria.
 */
const CONTATO_QUE_PARA = "cccccccc-0426-4000-8000-000000000001";
const OUTRO_NUMERO = "cccccccc-0426-4000-8000-000000000021";
const CONVERSA_1 = "cccccccc-0426-4000-8000-000000000011";
const CONVERSA_2 = "cccccccc-0426-4000-8000-000000000012";

function abrir(kind: string, conversa: string, status = "open"): void {
  sql(`insert into public.agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id, status)
       values ('${GOV_ORG}', '${kind}', 'warn', 'Um cliente parece pedir', 'corpo', 'conversation', '${conversa}', '${status}');`);
}

/** `kind=status` (e `+fim` quando `resolved_at` foi preenchido), em ordem de kind. */
function avisosDa(conversa: string): string[] {
  const saida = sql(`select kind || '=' || status || case when resolved_at is not null then '+fim' else '' end
                       from public.agent_inbox_items
                      where organization_id = '${GOV_ORG}' and ref_id = '${conversa}'
                      order by kind, created_at;`);
  return saida === "" ? [] : saida.split("\n");
}

function limpar(): void {
  sql(`delete from public.agent_inbox_items where organization_id = '${GOV_ORG}';
       update public.conversations
          set assigned_to_user_id = null, assignee_kind = null, status = 'open',
              bot_silenced_until = null, last_handoff_at = null
        where id in ('${GOV_CONV_UNASSIGNED}', '${GOV_CONV_CLAIM}', '${CONVERSA_1}', '${CONVERSA_2}');
       update public.contacts set is_blocked = false where id = '${CONTATO_QUE_PARA}';
       delete from public.agent_inbox_items where organization_id = '${GOV_ORG}';`);
}

beforeAll(() => {
  seedGov();
  sql(`insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
         values ('${OUTRO_NUMERO}', '${GOV_ORG}', 'gov-inv-0426', '\\x00'::bytea);
       insert into public.contacts (id, organization_id, display_name)
         values ('${CONTATO_QUE_PARA}', '${GOV_ORG}', 'Contato que pede para parar');
       insert into public.conversations (id, organization_id, contact_id, channel_session_id, status)
         values ('${CONVERSA_1}', '${GOV_ORG}', '${CONTATO_QUE_PARA}', '${GOV_SESSION}', 'open'),
                ('${CONVERSA_2}', '${GOV_ORG}', '${CONTATO_QUE_PARA}', '${OUTRO_NUMERO}', 'open');`);
  // Controle: as duas conversas existem (um insert recusado deixaria o caso do bloqueio passar vazio).
  expect(sql(`select count(*) from public.conversations where contact_id = '${CONTATO_QUE_PARA}';`)).toBe("2");
});

describe("o aviso de pessoa fecha quando a conversa é passada a uma pessoa, por qualquer caminho", () => {
  /**
   * A escrita de `performHumanHandoff` (lib/agent-engine/agent/human-handoff.ts):
   * a regra de hoje, o descadastro ambíguo e a ferramenta `request_human_handoff`
   * do modelo passam por ela. Com a conversa em `open`, o status nem muda.
   */
  it("a passagem do turno (performHumanHandoff): fecha o de pessoa, e o de parar de receber fica", () => {
    limpar();
    for (const kind of KINDS) abrir(kind, GOV_CONV_UNASSIGNED);
    abrir("jev_pedido_de_humano", GOV_CONV_CLAIM);
    sql(`update public.conversations
            set status = case when status = 'ai_handling' then 'pending' else status end,
                bot_silenced_until = 'infinity', last_handoff_at = now(), last_handoff_reason = 'pedido explícito',
                active_ai_agent_id = null, active_intent = null, active_agent_set_at = null
          where organization_id = '${GOV_ORG}' and id = '${GOV_CONV_UNASSIGNED}';`);
    expect(avisosDa(GOV_CONV_UNASSIGNED)).toEqual(["jev_parar_de_receber=open", "jev_pedido_de_humano=resolved+fim"]);
    expect(avisosDa(GOV_CONV_CLAIM), "a vizinha fica").toEqual(["jev_pedido_de_humano=open"]);
  });

  /**
   * A pausa manual da IA (lib/escalacao/atendimento-manual.ts) grava só o
   * silêncio e o `last_handoff_at`, sem tocar no status — o caso que o gatilho
   * de atribuição da 0228 (`update of assigned_to_user_id,status`) não vê.
   */
  it("a pausa manual (só silêncio e last_handoff_at, sem status): fecha o de pessoa", () => {
    limpar();
    abrir("jev_pedido_de_humano", GOV_CONV_UNASSIGNED);
    sql(`update public.conversations
            set bot_silenced_until = now() + interval '2 hours', last_handoff_at = now(), last_handoff_reason = 'manual'
          where id = '${GOV_CONV_UNASSIGNED}';`);
    expect(avisosDa(GOV_CONV_UNASSIGNED)).toEqual(["jev_pedido_de_humano=resolved+fim"]);
  });

  it("o orquestrador do clima (status pending + silêncio): fecha o de pessoa", () => {
    limpar();
    abrir("jev_pedido_de_humano", GOV_CONV_UNASSIGNED);
    sql(`update public.conversations
            set status = 'pending', bot_silenced_until = 'infinity', last_handoff_at = now(), status_changed_at = now()
          where id = '${GOV_CONV_UNASSIGNED}';`);
    expect(avisosDa(GOV_CONV_UNASSIGNED)).toEqual(["jev_pedido_de_humano=resolved+fim"]);
  });

  it("o robô reativado (silêncio limpo) e um silêncio que não muda não fecham nada", () => {
    limpar();
    sql(`update public.conversations set bot_silenced_until = 'infinity' where id = '${GOV_CONV_UNASSIGNED}';`);
    abrir("jev_pedido_de_humano", GOV_CONV_UNASSIGNED);
    // O mesmo silêncio de novo (um update que regrava a coluna com o mesmo valor).
    sql(`update public.conversations set bot_silenced_until = 'infinity' where id = '${GOV_CONV_UNASSIGNED}';`);
    expect(avisosDa(GOV_CONV_UNASSIGNED)).toEqual(["jev_pedido_de_humano=open"]);
    sql(`update public.conversations set bot_silenced_until = null, last_handoff_at = null where id = '${GOV_CONV_UNASSIGNED}';`);
    expect(avisosDa(GOV_CONV_UNASSIGNED)).toEqual(["jev_pedido_de_humano=open"]);
  });
});

describe("o aviso de parar de receber fecha quando o contato é bloqueado", () => {
  it("bloqueado (pela regra ou por uma pessoa): fecha o das DUAS conversas dele; o de pessoa e o de outro contato ficam", () => {
    limpar();
    abrir("jev_parar_de_receber", CONVERSA_1);
    abrir("jev_parar_de_receber", CONVERSA_2);
    abrir("jev_pedido_de_humano", CONVERSA_1);
    abrir("jev_parar_de_receber", GOV_CONV_UNASSIGNED);

    sql(`update public.contacts set is_blocked = true where organization_id = '${GOV_ORG}' and id = '${CONTATO_QUE_PARA}';`);

    expect(avisosDa(CONVERSA_1)).toEqual(["jev_parar_de_receber=resolved+fim", "jev_pedido_de_humano=open"]);
    expect(avisosDa(CONVERSA_2)).toEqual(["jev_parar_de_receber=resolved+fim"]);
    expect(avisosDa(GOV_CONV_UNASSIGNED), "outro contato").toEqual(["jev_parar_de_receber=open"]);
  });

  it("o contato já bloqueado, atualizado de novo: não fecha o aviso reaberto por alguém", () => {
    limpar();
    sql(`update public.contacts set is_blocked = true where id = '${CONTATO_QUE_PARA}';`);
    abrir("jev_parar_de_receber", CONVERSA_1);
    sql(`update public.contacts set is_blocked = true where id = '${CONTATO_QUE_PARA}';`);
    expect(avisosDa(CONVERSA_1)).toEqual(["jev_parar_de_receber=open"]);
  });
});

describe("um aviso do Jev por conversa e pedido, no banco", () => {
  it("o segundo do mesmo kind e conversa é recusado com qualquer status; outro kind, outra conversa e o handoff entram", () => {
    limpar();
    abrir("jev_pedido_de_humano", GOV_CONV_UNASSIGNED, "resolved");
    expect(() => abrir("jev_pedido_de_humano", GOV_CONV_UNASSIGNED)).toThrow(/agent_inbox_jev_pedido_unico/);
    abrir("jev_parar_de_receber", GOV_CONV_UNASSIGNED);
    abrir("jev_pedido_de_humano", GOV_CONV_CLAIM);
    abrir("handoff", GOV_CONV_UNASSIGNED);
    abrir("handoff", GOV_CONV_UNASSIGNED);
    expect(avisosDa(GOV_CONV_UNASSIGNED)).toEqual([
      "handoff=open",
      "handoff=open",
      "jev_parar_de_receber=open",
      "jev_pedido_de_humano=resolved",
    ]);
  });

  /** O que o gravador faz depois do 23505: o pedido novo reabre o aviso que existe. */
  it("reabrir o resolvido é um update na linha única", () => {
    limpar();
    sql(`insert into public.agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id, status, resolved_at)
         values ('${GOV_ORG}', 'jev_pedido_de_humano', 'warn', 't', 'c', 'conversation', '${GOV_CONV_UNASSIGNED}', 'resolved', now());`);
    sql(`update public.agent_inbox_items set status = 'open', resolved_at = null
          where organization_id = '${GOV_ORG}' and kind = 'jev_pedido_de_humano' and ref_kind = 'conversation'
            and ref_id = '${GOV_CONV_UNASSIGNED}';`);
    expect(avisosDa(GOV_CONV_UNASSIGNED)).toEqual(["jev_pedido_de_humano=open"]);
  });

  /**
   * O `update.sh` num clone que JÁ tem repetidos (quem rodou o PR antes do
   * conserto): o trecho da migration que cria o índice tira os repetidos antes
   * — fica o aberto — e não quebra.
   */
  it("com repetidos no banco, a migration deduplica (fica o aberto) e cria o índice", () => {
    limpar();
    const migration = readFileSync("supabase/migrations/20260926130000_0426_avisos_do_jev_na_central.sql", "utf8");
    const ini = migration.indexOf("delete from public.agent_inbox_items a");
    const fim = migration.indexOf("-- 3. O AVISO FECHA");
    expect(ini, "o trecho da deduplicação mudou de forma — atualize o caso").toBeGreaterThan(0);
    expect(fim).toBeGreaterThan(ini);
    const trecho = migration.slice(ini, fim);
    expect(trecho).toContain("create unique index if not exists agent_inbox_jev_pedido_unico");

    sql(`drop index public.agent_inbox_jev_pedido_unico;`);
    abrir("jev_pedido_de_humano", GOV_CONV_UNASSIGNED, "resolved");
    abrir("jev_pedido_de_humano", GOV_CONV_UNASSIGNED, "open");
    abrir("jev_pedido_de_humano", GOV_CONV_UNASSIGNED, "resolved");
    abrir("jev_parar_de_receber", GOV_CONV_UNASSIGNED);
    sql(trecho);

    expect(avisosDa(GOV_CONV_UNASSIGNED)).toEqual(["jev_parar_de_receber=open", "jev_pedido_de_humano=open"]);
    expect(() => abrir("jev_pedido_de_humano", GOV_CONV_UNASSIGNED)).toThrow(/agent_inbox_jev_pedido_unico/);
  });
});
