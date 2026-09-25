import { beforeAll, describe, expect, it } from "vitest";

import { GOV_AGENT_A, GOV_ORG, GOV_SESSION, seedGov, sql } from "./gov-helpers";

/**
 * G5-03 — fila visível + atribuição via worker (spec 13 §5).
 *
 * Prova no Postgres descartável:
 *  (a) acceptance 3 — o assign via fn_conversation_assign(reason='routing')
 *      deixa `unread_count_for_assignee` CORRETO (=0, fresh), sem carregar valor
 *      STALE de antes da atribuição. Semeamos unread=7 (dono anterior) e provamos
 *      que a atribuição do worker zera — o novo dono não herda contagem alheia.
 *  (b) acceptance 1 (coerência) — a MEMBRESIA da fila (o predicado que o listing
 *      e o counts.unassigned compartilham: sem dono ∧ status='open') não depende
 *      da ordenação por tempo de espera. Após o assign, a conversa SAI da fila.
 *
 * Namespace 4050/3050 (não colide com 4040/3040 do gov-4b nem 4444/3333 do helper).
 */

// Conversa na fila com unread "stale" de um dono anterior.
const CONV_STALE = "cccccccc-4050-4000-8000-000000000001";
const CONTACT = "cccccccc-3050-4000-8000-000000000001";

// 3 conversas de tempos de espera conhecidos (coerência ordem↔posição).
const CONV_OLD = "cccccccc-4050-4000-8000-000000000002"; // espera há 30 min ⇒ pos 1
const CONV_MID = "cccccccc-4050-4000-8000-000000000003"; // espera há 10 min ⇒ pos 2
const CONV_NEW = "cccccccc-4050-4000-8000-000000000004"; // espera há 2 min  ⇒ pos 3
const CONTACT_N = (n: number) => `cccccccc-3050-4000-8000-00000000000${n}`;

// Predicado ÚNICO da fila = o de counts.unassigned (app/api/v1/conversations/counts).
const QUEUE_PREDICATE = `assigned_to_user_id is null and status = 'open'`;

function unreadOf(id: string): number {
  return Number(
    sql(`select unread_count_for_assignee from public.conversations where id = '${id}';`),
  );
}
function inQueue(id: string): boolean {
  return (
    sql(
      `select count(*) from public.conversations where id = '${id}' and ${QUEUE_PREDICATE};`,
    ) === "1"
  );
}

beforeAll(() => {
  seedGov();
  sql(`
    insert into public.contacts (id, organization_id, display_name)
      values ('${CONTACT}', '${GOV_ORG}', 'Queue Stale Contact')
      on conflict do nothing;

    -- Entra na fila (sem dono, open) MAS carregando unread=7 de um dono anterior.
    insert into public.conversations
      (id, organization_id, contact_id, channel_session_id, status,
       unread_count_for_assignee, last_inbound_at)
      values ('${CONV_STALE}', '${GOV_ORG}', '${CONTACT}', '${GOV_SESSION}', 'open', 7, now())
      on conflict do nothing;

    insert into public.contacts (id, organization_id, display_name)
      values
        ('${CONTACT_N(2)}', '${GOV_ORG}', 'Queue Order Contact Old'),
        ('${CONTACT_N(3)}', '${GOV_ORG}', 'Queue Order Contact Mid'),
        ('${CONTACT_N(4)}', '${GOV_ORG}', 'Queue Order Contact New')
      on conflict do nothing;

    -- Tempos de espera conhecidos — e a coluna da espera é o awaiting_since,
    -- a régua da Fila desde o #1036: quanto MAIS antigo, mais cedo na fila.
    --
    -- O CONV_OLD é o caso que SEPARA as duas réguas: esperando há 30 min e, ao
    -- mesmo tempo, com o last_inbound_at mais NOVO dos três (ele é quem
    -- insistiu). Pela régua antiga (last_inbound_at, que reiniciava a espera a
    -- cada mensagem do cliente) ele seria o ÚLTIMO da fila; pela viva, é o
    -- primeiro. Fixture em que as duas colunas contam a MESMA história fica
    -- verde nos dois mundos — e o caso abaixo passaria sem medir a régua que o
    -- produto usa.
    insert into public.conversations
      (id, organization_id, contact_id, channel_session_id, status, awaiting_since, last_inbound_at)
      values
        ('${CONV_OLD}', '${GOV_ORG}', '${CONTACT_N(2)}', '${GOV_SESSION}', 'open', now() - interval '30 minutes', now()),
        ('${CONV_MID}', '${GOV_ORG}', '${CONTACT_N(3)}', '${GOV_SESSION}', 'open', now() - interval '10 minutes', now() - interval '10 minutes'),
        ('${CONV_NEW}', '${GOV_ORG}', '${CONTACT_N(4)}', '${GOV_SESSION}', 'open', now() - interval '2 minutes', now() - interval '2 minutes')
      on conflict do nothing;
  `);
});

describe("G5-03 — coerência ordem↔posição (acceptance 1)", () => {
  it("fila ordenada por awaiting_since ASC, id ASC (a MESMA ordem que gera a posição) ⇒ mais antigo na espera = posição 1", () => {
    // Espelha a régua da Fila — `ORDEM_DA_ESPERA`, em
    // lib/inbox/comando-da-conversa.ts: `awaiting_since asc nulls last, id asc`,
    // com a espera sendo a mensagem do cliente mais antiga ainda sem resposta
    // (desde o #1036; antes era o `last_inbound_at`, reescrito a cada mensagem
    // nova). A posição exibida é o índice nesta lista, então provamos a lista em
    // si.
    const ordered = sql(
      `select string_agg(id::text, ',' order by awaiting_since asc nulls last, id asc)
         from public.conversations
        where organization_id = '${GOV_ORG}'
          and id in ('${CONV_OLD}', '${CONV_MID}', '${CONV_NEW}');`,
    );
    expect(ordered).toBe(`${CONV_OLD},${CONV_MID},${CONV_NEW}`);
  });

  it("o fixture separa as duas réguas (no CONV_OLD o awaiting_since é mais antigo que o last_inbound_at)", () => {
    // Guarda da guarda: se alguém "normalizar" a fixture e as duas colunas
    // passarem a contar a mesma história, o caso acima fica verde também pela
    // régua antiga — e uma regressão para `last_inbound_at` na Fila deixaria de
    // acender.
    const discordam = sql(
      `select (awaiting_since < last_inbound_at)::int
         from public.conversations where id = '${CONV_OLD}';`,
    );
    expect(discordam).toBe("1");
  });
});

describe("G5-03 — fila: membresia coerente com counts.unassigned (acceptance 1)", () => {
  it("conversa sem dono + open ⇒ está na fila (mesmo predicado do counts)", () => {
    expect(inQueue(CONV_STALE)).toBe(true);
  });
});

describe("G5-03 — atribuição via worker zera unread (acceptance 3)", () => {
  it("antes do assign: unread stale do dono anterior = 7", () => {
    expect(unreadOf(CONV_STALE)).toBe(7);
  });

  it("após fn_conversation_assign(reason='routing'): unread_count_for_assignee = 0 (fresh, sem stale)", () => {
    sql(
      `select 1 from public.fn_conversation_assign('${GOV_ORG}', '${CONV_STALE}', '${GOV_AGENT_A}', 'routing', null, false);`,
    );
    expect(unreadOf(CONV_STALE)).toBe(0);
  });

  it("após o assign: conversa SAI da fila (ganhou dono) — coerência fila↔counts", () => {
    expect(inQueue(CONV_STALE)).toBe(false);
    const assignee = sql(
      `select (assigned_to_user_id = '${GOV_AGENT_A}')::int from public.conversations where id = '${CONV_STALE}';`,
    );
    expect(assignee).toBe("1");
  });
});
