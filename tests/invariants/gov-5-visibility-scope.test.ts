import { beforeAll, describe, expect, it } from "vitest";

import {
  GOV_AGENT_A,
  GOV_AGENT_B,
  GOV_CONTACT_2,
  GOV_CONV_AGENT_B,
  GOV_CONV_UNASSIGNED,
  GOV_MANAGER,
  GOV_ORG,
  GOV_SESSION,
  countAs,
  seedGov,
  sql,
} from "./gov-helpers";

/**
 * Eixo 5 — Escopo de visualização (spec 13 §1; fecha em G4-01).
 * docs/specs/13-spec-governanca-atendimento.md — dor: '"select sem where":
 * atendente vê tudo; métricas sem filtro por responsável'. Matriz alvo §4
 * (agent = own*; visibility_mode em §3.5, default 'own_and_unassigned' — G1-06a).
 *
 * A RLS (migration 0035) aplica fn_can_view_conversation no SELECT de
 * conversations/messages: só o role `agent` é restrito por visibility_mode;
 * viewer/manager/admin seguem org-wide. Realtime (postgres_changes) HERDA esta
 * mesma policy de SELECT — a subscription do inbox não entrega conversa fora do
 * escopo (evidência: os counts=0 abaixo são exatamente o filtro que o Realtime
 * usa; ver hooks/inbox/useConversationsRealtime.ts).
 */

// Fixtures locais deste arquivo — nunca mutam o GOV_ORG compartilhado (paralelo
// com os outros gov-*.test.ts). Namespace ffffffff = exclusivo deste arquivo
// (cccccccc/dddddddd/eeeeeeee já são usados por outros invariantes paralelos).
const OWN_ORG = "ffffffff-0000-4000-8000-000000000001";
const OWN_SESSION = "ffffffff-2222-4000-8000-000000000001";
const OWN_CONTACT = "ffffffff-3333-4000-8000-000000000001";
const OWN_CONV_UNASSIGNED = "ffffffff-4444-4000-8000-000000000001";
const GOV_MSG_AGENT_B = "ffffffff-7777-4000-8000-000000000001";

beforeAll(() => {
  seedGov();
  // 1 mensagem na conversa do agent B (probe de herança messages←conversation).
  sql(`
    insert into public.messages
      (id, organization_id, conversation_id, channel_session_id, contact_id, type, direction, body)
    values
      ('${GOV_MSG_AGENT_B}', '${GOV_ORG}', '${GOV_CONV_AGENT_B}', '${GOV_SESSION}', '${GOV_CONTACT_2}',
       'text', 'inbound', 'gov invariant probe')
    on conflict (id) do nothing;

    -- Org dedicada em modo 'own' (fila NÃO conta): agent A é membro, 1 conversa
    -- sem dono. Isola o teste de 'own' sem tocar no visibility_mode do GOV_ORG.
    insert into public.organizations (id, slug, legal_name, display_name, settings)
      values ('${OWN_ORG}', 'gov-own', 'Gov Own Org', 'Gov Own',
              jsonb_build_object('visibility_mode', 'own'))
      on conflict do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${GOV_AGENT_A}', '${OWN_ORG}', 'agent', now()) on conflict do nothing;
    do $gov$ begin
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
        values ('${OWN_SESSION}', '${OWN_ORG}', 'gov-own', '\\x00'::bytea);
    exception when unique_violation then null; end $gov$;
    insert into public.contacts (id, organization_id, display_name)
      values ('${OWN_CONTACT}', '${OWN_ORG}', 'Gov Own Contact') on conflict do nothing;
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status)
      values ('${OWN_CONV_UNASSIGNED}', '${OWN_ORG}', '${OWN_CONTACT}', '${OWN_SESSION}', 'open')
      on conflict do nothing;
  `);
});

describe("eixo 5 — escopo de visualização", () => {
  it("agent vê a própria conversa atribuída (controle positivo)", () => {
    expect(
      countAs(
        GOV_AGENT_B,
        `select count(*) from public.conversations where id = '${GOV_CONV_AGENT_B}';`,
      ),
    ).toBe(1);
  });

  it("agent NÃO vê conversa atribuída a outro agent (spec 13 §4: agent = own*)", () => {
    expect(
      countAs(
        GOV_AGENT_A,
        `select count(*) from public.conversations where id = '${GOV_CONV_AGENT_B}';`,
      ),
    ).toBe(0);
  });

  it("agent vê a fila não-atribuída no default 'own_and_unassigned' (G1-06a)", () => {
    expect(
      countAs(
        GOV_AGENT_A,
        `select count(*) from public.conversations where id = '${GOV_CONV_UNASSIGNED}';`,
      ),
    ).toBe(1);
  });

  it("agent NÃO vê a fila não-atribuída quando visibility_mode='own'", () => {
    expect(
      countAs(
        GOV_AGENT_A,
        `select count(*) from public.conversations where id = '${OWN_CONV_UNASSIGNED}';`,
      ),
    ).toBe(0);
  });

  it("manager vê TODAS as conversas da org (org-wide read)", () => {
    expect(
      countAs(
        GOV_MANAGER,
        `select count(*) from public.conversations
           where id in ('${GOV_CONV_AGENT_B}', '${GOV_CONV_UNASSIGNED}');`,
      ),
    ).toBe(2);
  });

  it("mensagem herda o escopo: agent A NÃO lê msg de conversa fora do escopo", () => {
    expect(
      countAs(
        GOV_AGENT_A,
        `select count(*) from public.messages where id = '${GOV_MSG_AGENT_B}';`,
      ),
    ).toBe(0);
  });

  it("mensagem herda o escopo: agent B lê a msg da própria conversa", () => {
    expect(
      countAs(
        GOV_AGENT_B,
        `select count(*) from public.messages where id = '${GOV_MSG_AGENT_B}';`,
      ),
    ).toBe(1);
  });
});
