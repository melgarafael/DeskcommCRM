import { beforeAll, describe, expect, it } from "vitest";

import {
  GOV_AGENT_A,
  GOV_AGENT_B,
  GOV_ORG,
  GOV_SESSION,
  countAs,
  lastLine,
  seedGov,
  sql,
  writeCountAs,
} from "./gov-helpers";

/**
 * Eixo 3 — G3-01: conversation_assignment_events + fn_conversation_assign
 * (migration 0031, spec 13 §3.1 + spec 04 §9).
 *
 * Invariantes:
 *  - claim/transfer/release via fn_conversation_assign gravam o evento na
 *    MESMA transação da mudança de assigned_to_user_id;
 *  - claim duplicado perde o optimistic lock (0 rows → rota devolve 409) e NÃO
 *    gera evento duplicado;
 *  - transferência re-zera unread_count_for_assignee (acceptance 5);
 *  - a tabela é append-only (sem policy de UPDATE/DELETE — família
 *    api_audit_log).
 */

// Fixture própria (namespace dddddddd) — não toca nas conversas do gov-helpers
// (GOV_CONV_CLAIM é reivindicada por gov-3-transfer.test.ts via UPDATE cru).
const CAE_CONTACT = "dddddddd-3333-4000-8000-000000000001";
const CAE_CONV = "dddddddd-4444-4000-8000-000000000001";

function eventCount(where: string): number {
  return countAs(
    GOV_AGENT_A,
    `select count(*) from public.conversation_assignment_events
      where conversation_id = '${CAE_CONV}' and ${where}`,
  );
}

function assignAs(userId: string, args: string): number {
  return countAs(
    userId,
    `select count(*) from public.fn_conversation_assign(
       '${GOV_ORG}'::uuid, '${CAE_CONV}'::uuid, ${args})`,
  );
}

beforeAll(() => {
  seedGov();
  sql(`
    insert into public.contacts (id, organization_id, display_name)
      values ('${CAE_CONTACT}', '${GOV_ORG}', 'Gov Invariant Contact CAE')
      on conflict do nothing;
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status)
      values ('${CAE_CONV}', '${GOV_ORG}', '${CAE_CONTACT}', '${GOV_SESSION}', 'open')
      on conflict do nothing;
  `);
});

describe("eixo 3 — G3-01: eventos de atribuição", () => {
  it("claim via fn_conversation_assign atribui E grava evento reason='claim' na mesma transação", () => {
    const rows = assignAs(GOV_AGENT_A, `'${GOV_AGENT_A}'::uuid, 'claim', null::uuid, true`);
    expect(rows).toBe(1);

    expect(
      eventCount(
        `reason = 'claim' and from_user_id is null
         and to_user_id = '${GOV_AGENT_A}' and changed_by = '${GOV_AGENT_A}'`,
      ),
    ).toBe(1);
  });

  it("claim duplicado: optimistic lock perde (0 rows → rota 409) e ZERO evento duplicado", () => {
    const rows = assignAs(GOV_AGENT_B, `'${GOV_AGENT_B}'::uuid, 'claim', null::uuid, true`);
    expect(rows).toBe(0);

    // Nenhum evento novo: segue exatamente 1 claim registrado.
    expect(eventCount(`reason = 'claim'`)).toBe(1);
  });

  it("transfer é imediata (G1-06d), grava evento from→to e re-zera unread_count_for_assignee", () => {
    // Simula não-lidas acumuladas do dono atual antes da transferência.
    sql(`update public.conversations set unread_count_for_assignee = 5 where id = '${CAE_CONV}';`);

    const rows = assignAs(GOV_AGENT_A, `'${GOV_AGENT_B}'::uuid, 'transfer', null::uuid, false`);
    expect(rows).toBe(1);

    expect(
      eventCount(
        `reason = 'transfer' and from_user_id = '${GOV_AGENT_A}'
         and to_user_id = '${GOV_AGENT_B}' and changed_by = '${GOV_AGENT_A}'`,
      ),
    ).toBe(1);

    const state = lastLine(
      sql(
        `select unread_count_for_assignee || '|' || assigned_to_user_id
           from public.conversations where id = '${CAE_CONV}';`,
      ),
    );
    expect(state).toBe(`0|${GOV_AGENT_B}`);
  });

  it("release grava evento reason='release' e devolve a conversa à fila", () => {
    const rows = assignAs(GOV_AGENT_B, `null::uuid, 'release', '${GOV_AGENT_B}'::uuid, true`);
    expect(rows).toBe(1);

    expect(
      eventCount(`reason = 'release' and from_user_id = '${GOV_AGENT_B}' and to_user_id is null`),
    ).toBe(1);

    const state = lastLine(
      sql(
        `select status || '|' || coalesce(assigned_to_user_id::text, 'null')
           from public.conversations where id = '${CAE_CONV}';`,
      ),
    );
    expect(state).toBe("open|null");
  });

  it("append-only: UPDATE e DELETE em conversation_assignment_events são negados por RLS", () => {
    const updated = writeCountAs(
      GOV_AGENT_A,
      `update public.conversation_assignment_events set reason = 'routing'
        where conversation_id = '${CAE_CONV}'`,
    );
    expect(updated).toBe(0);

    const deleted = writeCountAs(
      GOV_AGENT_A,
      `delete from public.conversation_assignment_events
        where conversation_id = '${CAE_CONV}'`,
    );
    expect(deleted).toBe(0);

    // Os eventos continuam lá (história intacta).
    expect(eventCount("true")).toBe(3);
  });
});
