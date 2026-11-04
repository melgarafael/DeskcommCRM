import { beforeAll, describe, expect, it } from "vitest";
import { sql } from "./psql-transporte";
import { countAs } from "./gov-helpers";
const ORG_A = "29420000-0000-4000-8000-000000000001";
const ORG_B = "29420000-0000-4000-8000-000000000002";
/** Dono da conversa. */
const ATENDENTE_A = "29420000-1111-4000-8000-000000000001";
/** Colega, mesmo papel, sem a conversa. É o CONVIDADO. */
const ATENDENTE_B = "29420000-1111-4000-8000-000000000002";
const GESTOR = "29420000-1111-4000-8000-000000000003";
/** Membro `agent` da OUTRA organização — o eixo cross-tenant. */
const ATENDENTE_B_ORG = "29420000-1111-4000-8000-000000000004";
const SESSAO_A = "29420000-2222-4000-8000-000000000001";
const CONTATO_A = "29420000-3333-4000-8000-000000000001";
const CONVERSA_A = "29420000-4444-4000-8000-000000000001";
const MENSAGEM_A = "29420000-5555-4000-8000-000000000001";

const CONVERSAS_QUE_VEJO = `select count(*) from public.conversations
   where organization_id = '${ORG_A}' and id = '${CONVERSA_A}'`;
beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${ATENDENTE_A}',     'scoped-2942-a@invariant.test'),
      ('${ATENDENTE_B}',     'scoped-2942-b@invariant.test'),
      ('${GESTOR}',          'scoped-2942-gestor@invariant.test'),
      ('${ATENDENTE_B_ORG}', 'scoped-2942-b-org@invariant.test')
      on conflict do nothing;

    -- visibility_mode = 'own': o modo mais estrito, e o único em que o recorte
    -- por atendente aparece (ver o cabeçalho).
    insert into public.organizations (id, slug, legal_name, display_name, settings)
      values ('${ORG_A}', 'scoped-2942-a', 'Conjunto 2542 A', 'Conjunto A',
              '{"visibility_mode":"own"}'::jsonb),
             ('${ORG_B}', 'scoped-2942-b', 'Conjunto 2542 B', 'Conjunto B',
              '{"visibility_mode":"own"}'::jsonb)
      on conflict (id) do update set settings = excluded.settings;

    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${ATENDENTE_A}',     '${ORG_A}', 'agent',   now()),
      ('${ATENDENTE_B}',     '${ORG_A}', 'agent',   now()),
      ('${GESTOR}',          '${ORG_A}', 'manager', now()),
      ('${ATENDENTE_B_ORG}', '${ORG_B}', 'agent',   now())
      on conflict do nothing;

    -- DO + exception (não ON CONFLICT): channel_sessions tem unique DEFERRABLE
    -- (phone_per_org), que ON CONFLICT sem arbiter rejeita.
    do $seed$ begin
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
        values ('${SESSAO_A}', '${ORG_A}', 'scoped-2942', '\\x00'::bytea);
    exception when unique_violation then null; end $seed$;

    insert into public.contacts (id, organization_id, display_name)
      values ('${CONTATO_A}', '${ORG_A}', 'Conjunto 2542 Contato')
      on conflict do nothing;

    -- A conversa tem DONO, e é isso que faz a medição existir.
    insert into public.conversations
        (id, organization_id, contact_id, channel_session_id, status, assigned_to_user_id)
      values ('${CONVERSA_A}', '${ORG_A}', '${CONTATO_A}', '${SESSAO_A}', 'open', '${ATENDENTE_A}')
      on conflict (id) do update set assigned_to_user_id = excluded.assigned_to_user_id;

    insert into public.messages
        (id, organization_id, conversation_id, channel_session_id, contact_id, type, direction, body)
      values ('${MENSAGEM_A}', '${ORG_A}', '${CONVERSA_A}', '${SESSAO_A}', '${CONTATO_A}',
              'text', 'inbound', 'conjunto 2542 probe')
      on conflict (id) do nothing;

    -- A participação ATIVA do colega: é ela que faz o convidado ver a conversa.
    insert into public.conversation_participants
        (organization_id, conversation_id, user_id, invited_by, joined_at, left_at)
      values ('${ORG_A}', '${CONVERSA_A}', '${ATENDENTE_B}', '${ATENDENTE_A}', now(), null)
      on conflict (conversation_id, user_id) do update set left_at = null;
    insert into public.member_access_scopes(organization_id,user_id,channel_ids,restrict_contacts)
      values ('${ORG_A}','${ATENDENTE_B}',array['${SESSAO_A}']::uuid[],false)
      on conflict(organization_id,user_id) do update set channel_ids=excluded.channel_ids;
  `);
});

describe("Escopo optativo: convite não amplia carteira opt-in", () => {
  it("semente existe e participação está ativa", () => {
    expect(
      sql(
        `select count(*) from public.conversation_participants where conversation_id='${CONVERSA_A}' and left_at is null;`,
      ).trim(),
    ).toBe("1");
  });
  it("participante com canal permitido mas carteira de outro não vê conversa", () => {
    expect(countAs(ATENDENTE_B, CONVERSAS_QUE_VEJO)).toBe(0);
  });
  it("dono preserva acesso", () => {
    expect(countAs(ATENDENTE_A, CONVERSAS_QUE_VEJO)).toBe(1);
  });
  it("outro tenant continua negado", () => {
    expect(countAs(ATENDENTE_B_ORG, CONVERSAS_QUE_VEJO)).toBe(0);
  });
});
