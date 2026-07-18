import { beforeAll, describe, expect, it } from "vitest";

import { countAs, sql } from "./gov-helpers";

/**
 * G4-02 — Inbox com escopo: contagens por visão RLS-scoped (acceptance 1/GAP B)
 * e o "esconderijo cosmético" fechado (GAP A): um agent em modo own* que force
 * a visão 'Todas' (?filter=all → a query de listagem/contagem NÃO filtra por
 * assigned_to) continua recebendo APENAS o seu escopo — a RLS (migration 0035,
 * fn_can_view_conversation) é quem garante, não a tab escondida.
 *
 * As três contagens espelham /api/v1/conversations/counts (client user-scoped):
 *   all         = select count(*) where organization_id = X            (sem filtro)
 *   unassigned  = ... and assigned_to_user_id is null and status='open'
 *   mine        = ... and assigned_to_user_id = <caller>
 *
 * Prova central: countAs(agent, all) = escopo (own+fila) < countAs(manager, all)
 * = total da org. Se o count viesse de um client admin/service-role (que vê tudo),
 * agent == manager e este teste quebra. Org dedicada (namespace a1b2c3d4) para ser
 * determinística sob execução paralela com os outros gov-*.
 */
const ORG = "a1b2c3d4-0000-4000-8000-000000000001";
const AGENT = "a1b2c3d4-1111-4000-8000-000000000001";
const OTHER_AGENT = "a1b2c3d4-1111-4000-8000-000000000002";
const MANAGER = "a1b2c3d4-1111-4000-8000-000000000003";
const SESSION = "a1b2c3d4-2222-4000-8000-000000000001";
const CONTACT_MINE = "a1b2c3d4-3333-4000-8000-000000000001";
const CONTACT_QUEUE = "a1b2c3d4-3333-4000-8000-000000000002";
const CONTACT_OTHER = "a1b2c3d4-3333-4000-8000-000000000003";
const CONV_MINE = "a1b2c3d4-4444-4000-8000-000000000001";
const CONV_QUEUE = "a1b2c3d4-4444-4000-8000-000000000002";
const CONV_OTHER = "a1b2c3d4-4444-4000-8000-000000000003";

const ALL = `select count(*) from public.conversations where organization_id = '${ORG}';`;
const UNASSIGNED = `select count(*) from public.conversations
  where organization_id = '${ORG}' and assigned_to_user_id is null and status = 'open';`;
const mineFor = (uid: string) => `select count(*) from public.conversations
  where organization_id = '${ORG}' and assigned_to_user_id = '${uid}';`;

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${AGENT}', 'gov5b-agent@invariant.test'),
      ('${OTHER_AGENT}', 'gov5b-other@invariant.test'),
      ('${MANAGER}', 'gov5b-manager@invariant.test')
      on conflict do nothing;

    -- Org em modo default own_and_unassigned (explícito p/ não depender do fallback).
    insert into public.organizations (id, slug, legal_name, display_name, settings)
      values ('${ORG}', 'gov5b', 'Gov 5b Org', 'Gov 5b',
              jsonb_build_object('visibility_mode', 'own_and_unassigned'))
      on conflict do nothing;

    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${AGENT}', '${ORG}', 'agent', now()),
      ('${OTHER_AGENT}', '${ORG}', 'agent', now()),
      ('${MANAGER}', '${ORG}', 'manager', now())
      on conflict do nothing;

    do $gov$ begin
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
        values ('${SESSION}', '${ORG}', 'gov5b', '\\x00'::bytea);
    exception when unique_violation then null; end $gov$;

    insert into public.contacts (id, organization_id, display_name) values
      ('${CONTACT_MINE}', '${ORG}', 'Gov5b Mine'),
      ('${CONTACT_QUEUE}', '${ORG}', 'Gov5b Queue'),
      ('${CONTACT_OTHER}', '${ORG}', 'Gov5b Other')
      on conflict do nothing;

    -- 1 minha (AGENT), 1 fila (sem dono), 1 de outro agent (fora do escopo).
    insert into public.conversations
      (id, organization_id, contact_id, channel_session_id, status, assigned_to_user_id, assigned_at) values
      ('${CONV_MINE}', '${ORG}', '${CONTACT_MINE}', '${SESSION}', 'claimed', '${AGENT}', now())
      on conflict do nothing;
    insert into public.conversations
      (id, organization_id, contact_id, channel_session_id, status) values
      ('${CONV_QUEUE}', '${ORG}', '${CONTACT_QUEUE}', '${SESSION}', 'open')
      on conflict do nothing;
    insert into public.conversations
      (id, organization_id, contact_id, channel_session_id, status, assigned_to_user_id, assigned_at) values
      ('${CONV_OTHER}', '${ORG}', '${CONTACT_OTHER}', '${SESSION}', 'claimed', '${OTHER_AGENT}', now())
      on conflict do nothing;
  `);
});

describe("G4-02 — contagens por visão são RLS-scoped", () => {
  it("agent na visão 'Todas' conta só o escopo (own + fila), NÃO o total da org", () => {
    // own(CONV_MINE) + fila(CONV_QUEUE) = 2; NÃO conta CONV_OTHER.
    expect(countAs(AGENT, ALL)).toBe(2);
  });

  it("manager na visão 'Todas' conta o total da org (org-wide read)", () => {
    expect(countAs(MANAGER, ALL)).toBe(3);
  });

  it("prova anti-admin: agent (2) < manager (3) — a contagem herda a RLS do caller", () => {
    expect(countAs(AGENT, ALL)).toBeLessThan(countAs(MANAGER, ALL));
  });

  it("agent 'Fila' = conversas abertas sem dono no escopo dele", () => {
    expect(countAs(AGENT, UNASSIGNED)).toBe(1);
  });

  it("agent 'Minhas' = só as atribuídas a ele", () => {
    expect(countAs(AGENT, mineFor(AGENT))).toBe(1);
  });

  it("forçar ?filter=all não vaza: agent não conta a conversa de outro agent", () => {
    expect(
      countAs(
        AGENT,
        `select count(*) from public.conversations where id = '${CONV_OTHER}';`,
      ),
    ).toBe(0);
  });
});
