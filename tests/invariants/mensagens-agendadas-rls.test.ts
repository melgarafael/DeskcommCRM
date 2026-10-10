import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import { countAs, lastLine, sql } from "./gov-helpers";

const orgA = randomUUID();
const orgB = randomUUID();
const agenteA = randomUUID();
const agenteB = randomUUID();
const conversaA = randomUUID();
const conversaOutroDono = randomUUID();
const conversaB = randomUUID();

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${agenteA}', 'agenda-mensagem-a@invariant.test'),
      ('${agenteB}', 'agenda-mensagem-b@invariant.test');
    insert into organizations (id, slug, legal_name, display_name, settings) values
      ('${orgA}', '${orgA}', 'Org A', 'Org A', '{"visibility_mode":"own"}'::jsonb),
      ('${orgB}', '${orgB}', 'Org B', 'Org B', '{"visibility_mode":"own"}'::jsonb);
    insert into user_organizations (user_id, organization_id, role, accepted_at) values
      ('${agenteA}', '${orgA}', 'agent', now()),
      ('${agenteB}', '${orgA}', 'agent', now()),
      ('${agenteB}', '${orgB}', 'agent', now());
  `);
  for (const [org, conversa, dono] of [
    [orgA, conversaA, agenteA],
    [orgA, conversaOutroDono, agenteB],
    [orgB, conversaB, agenteB],
  ]) {
    const sessao = randomUUID();
    const contato = randomUUID();
    sql(`
      insert into channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
        values ('${sessao}', '${org}', '${sessao}', '\\x00');
      insert into contacts (id, organization_id, display_name) values ('${contato}', '${org}', 'Contato');
      insert into conversations (id, organization_id, contact_id, channel_session_id, assigned_to_user_id)
        values ('${conversa}', '${org}', '${contato}', '${sessao}', '${dono}');
      insert into scheduled_messages (organization_id, conversation_id, created_by_user_id, body, scheduled_at)
        values ('${org}', '${conversa}', '${dono}', 'Mensagem de teste', now() + interval '1 day');
    `);
  }
});

describe("agendamentos do Inbox no banco real", () => {
  it("o atendente vê apenas a conversa que pode abrir", () => {
    expect(countAs(agenteA, "select count(*) from scheduled_messages")).toBe(1);
    expect(countAs(agenteB, "select count(*) from scheduled_messages")).toBe(2);
  });

  it("a REST autenticada pode ler, mas não criar nem cancelar diretamente", () => {
    const resultado = lastLine(
      sql(`
      select concat_ws(',',
        has_table_privilege('authenticated', 'public.scheduled_messages', 'SELECT')::int,
        has_table_privilege('authenticated', 'public.scheduled_messages', 'INSERT')::int,
        has_table_privilege('authenticated', 'public.scheduled_messages', 'UPDATE')::int,
        has_table_privilege('authenticated', 'public.scheduled_messages', 'DELETE')::int);
    `),
    );
    expect(resultado).toBe("1,0,0,0");
  });
});
