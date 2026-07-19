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

    -- Tempos de espera conhecidos: quanto MAIS antigo o last_inbound_at, mais cedo na fila.
    insert into public.conversations
      (id, organization_id, contact_id, channel_session_id, status, last_inbound_at)
      values
        ('${CONV_OLD}', '${GOV_ORG}', '${CONTACT_N(2)}', '${GOV_SESSION}', 'open', now() - interval '30 minutes'),
        ('${CONV_MID}', '${GOV_ORG}', '${CONTACT_N(3)}', '${GOV_SESSION}', 'open', now() - interval '10 minutes'),
        ('${CONV_NEW}', '${GOV_ORG}', '${CONTACT_N(4)}', '${GOV_SESSION}', 'open', now() - interval '2 minutes')
      on conflict do nothing;
  `);
});

describe("G5-03 — coerência ordem↔posição (acceptance 1)", () => {
  it("fila ordenada por last_inbound_at ASC, id ASC (a MESMA ordem que gera a posição) ⇒ mais antigo = posição 1", () => {
    // Espelha o ORDER BY do handler (app/api/v1/conversations/_handler.ts): a
    // posição exibida é o índice nesta lista, então provamos a lista em si.
    const ordered = sql(
      `select string_agg(id::text, ',' order by last_inbound_at asc nulls last, id asc)
         from public.conversations
        where organization_id = '${GOV_ORG}'
          and id in ('${CONV_OLD}', '${CONV_MID}', '${CONV_NEW}');`,
    );
    expect(ordered).toBe(`${CONV_OLD},${CONV_MID},${CONV_NEW}`);
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
