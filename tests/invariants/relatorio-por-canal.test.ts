import { beforeAll, describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

/**
 * Relatório por canal (issue #2390, migration 0590) contra o Postgres REAL do
 * baseline — o que os testes de `lib/metrics/canais.test.ts` e da rota não
 * alcançam: lá a RPC é lida como texto ou mockada.
 *
 * `fn_channel_metrics` é SECURITY INVOKER: quem separa organização e atendente
 * é a RLS de `conversations`/`messages`, não o `p_org`. Então o que se prova
 * aqui é o que um `p_org` forjado NÃO alcança, e que a régua é a da irmã
 * `fn_attendant_metrics` (bot fora, vazamento fora da média).
 *
 * Namespace c2390… (exclusivo deste arquivo). Sem PII: e-mails @invariant.test.
 * Timestamps LITERAIS fixos para agregações determinísticas.
 */

const ORG = "c2390000-0000-4000-8000-000000000001";
const ORG_2 = "c2390000-0000-4000-8000-000000000002";
const AGENT_A = "c2390000-1111-4000-8000-000000000001";
const AGENT_B = "c2390000-1111-4000-8000-000000000002";
const MANAGER = "c2390000-1111-4000-8000-000000000003";
const MANAGER_2 = "c2390000-1111-4000-8000-000000000004";
const S1 = "c2390000-2222-4000-8000-000000000001";
const S2 = "c2390000-2222-4000-8000-000000000002"; // arquivado
const S_ORG2 = "c2390000-2222-4000-8000-000000000003";
const CT1 = "c2390000-3333-4000-8000-000000000001";
const CT2 = "c2390000-3333-4000-8000-000000000002";
const CT3 = "c2390000-3333-4000-8000-000000000003";
const CT4 = "c2390000-3333-4000-8000-000000000004";
const CT_ORG2 = "c2390000-3333-4000-8000-000000000005";
const CV1 = "c2390000-4444-4000-8000-000000000001";
const CV2 = "c2390000-4444-4000-8000-000000000002";
const CV3 = "c2390000-4444-4000-8000-000000000003";
const CV_OLD = "c2390000-4444-4000-8000-000000000004";
const CV_ORG2 = "c2390000-4444-4000-8000-000000000005";

const FROM = "2026-07-01T00:00:00+00";
const TO = "2026-07-31T00:00:00+00";
const IN = "2026-07-10T12:00:00+00";
const OLD = "2026-05-01T12:00:00+00";

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${AGENT_A}', 'r2390-agent-a@invariant.test'),
      ('${AGENT_B}', 'r2390-agent-b@invariant.test'),
      ('${MANAGER}', 'r2390-manager@invariant.test'),
      ('${MANAGER_2}', 'r2390-manager-2@invariant.test')
    on conflict do nothing;

    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG}',   'r2390-canal',   'R2390 Canal Org',   'R2390 Canal'),
      ('${ORG_2}', 'r2390-canal-2', 'R2390 Canal Org 2', 'R2390 Canal 2')
    on conflict do nothing;

    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${AGENT_A}',   '${ORG}',   'agent',   now()),
      ('${AGENT_B}',   '${ORG}',   'agent',   now()),
      ('${MANAGER}',   '${ORG}',   'manager', now()),
      ('${MANAGER_2}', '${ORG_2}', 'manager', now())
    on conflict do nothing;

    insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted, display_name, archived_at) values
      ('${S1}',     '${ORG}',   'r2390-s1',     '\\x00'::bytea, 'Numero Um',   null),
      ('${S2}',     '${ORG}',   'r2390-s2',     '\\x00'::bytea, 'Numero Dois', '${IN}'),
      ('${S_ORG2}', '${ORG_2}', 'r2390-s-org2', '\\x00'::bytea, 'Outra Org',   null);

    insert into public.contacts (id, organization_id, display_name) values
      ('${CT1}', '${ORG}', 'R2390 Contato 1'),
      ('${CT2}', '${ORG}', 'R2390 Contato 2'),
      ('${CT3}', '${ORG}', 'R2390 Contato 3'),
      ('${CT4}', '${ORG}', 'R2390 Contato 4'),
      ('${CT_ORG2}', '${ORG_2}', 'R2390 Contato Org 2');

    -- S1: CV1 (agente A, IA responde antes do humano — a IA NÃO conta) e CV2
    -- (agente B). CV_OLD: atribuída fora da janela, não conta.
    -- S2 (arquivado): CV3, só a IA respondeu ⇒ vazamento, fora da média.
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status, assigned_to_user_id, assigned_at, assignee_kind) values
      ('${CV1}',     '${ORG}',   '${CT1}',     '${S1}',     'claimed', '${AGENT_A}',   '${IN}',  'user'),
      ('${CV2}',     '${ORG}',   '${CT2}',     '${S1}',     'claimed', '${AGENT_B}',   '${IN}',  'user'),
      ('${CV3}',     '${ORG}',   '${CT3}',     '${S2}',     'claimed', '${AGENT_A}',   '${IN}',  'user'),
      ('${CV_OLD}',  '${ORG}',   '${CT4}',     '${S1}',     'claimed', '${AGENT_A}',   '${OLD}', 'user'),
      ('${CV_ORG2}', '${ORG_2}', '${CT_ORG2}', '${S_ORG2}', 'claimed', '${MANAGER_2}', '${IN}',  'user');

    insert into public.messages (organization_id, conversation_id, channel_session_id, contact_id, type, direction, sent_via, sent_by_user_id, sent_at) values
      ('${ORG}', '${CV1}', '${S1}', '${CT1}', 'text', 'inbound',  'crm',  null,         '${IN}'),
      ('${ORG}', '${CV1}', '${S1}', '${CT1}', 'text', 'outbound', 'ai',   null,         '2026-07-10T12:00:10+00'),
      ('${ORG}', '${CV1}', '${S1}', '${CT1}', 'text', 'outbound', 'user', '${AGENT_A}', '2026-07-10T12:01:00+00'),
      ('${ORG}', '${CV2}', '${S1}', '${CT2}', 'text', 'inbound',  'crm',  null,         '${IN}'),
      ('${ORG}', '${CV2}', '${S1}', '${CT2}', 'text', 'outbound', 'user', '${AGENT_B}', '2026-07-10T12:02:00+00'),
      ('${ORG}', '${CV3}', '${S2}', '${CT3}', 'text', 'inbound',  'crm',  null,         '${IN}'),
      ('${ORG}', '${CV3}', '${S2}', '${CT3}', 'text', 'outbound', 'ai',   null,         '2026-07-10T12:00:05+00'),
      ('${ORG_2}', '${CV_ORG2}', '${S_ORG2}', '${CT_ORG2}', 'text', 'inbound',  'crm',  null,           '${IN}'),
      ('${ORG_2}', '${CV_ORG2}', '${S_ORG2}', '${CT_ORG2}', 'text', 'outbound', 'user', '${MANAGER_2}', '2026-07-10T12:00:20+00');
  `);
});

function asRole(actorId: string): string {
  return `set role authenticated;
    do $c$ begin perform set_config('request.jwt.claims', '{"sub":"${actorId}"}', false); end $c$;`;
}

type Linha = {
  channel_session_id: string;
  channel_name: string | null;
  is_archived: boolean;
  conversations_handled: number;
  avg_first_response_seconds: number | null;
  sem_resposta: number;
};

/** As linhas da RPC sob a sessão de `actorId`, pedindo a organização `org`. */
function canais(actorId: string, org: string, owner?: string): Linha[] {
  const p_owner = owner ? `'${owner}'::uuid` : "null";
  const out = sql(`
    ${asRole(actorId)}
    select 'ROW:' || (public.fn_channel_metrics('${org}', '${FROM}', '${TO}', ${p_owner}) -> 'channels')::text;
  `);
  const json = out.split("\n").pop()!.replace(/^ROW:/, "");
  return JSON.parse(json) as Linha[];
}

function resumo(linhas: Linha[]) {
  return linhas.map((l) => ({
    id: l.channel_session_id,
    nome: l.channel_name,
    arquivado: l.is_archived,
    conversas: l.conversations_handled,
    media: l.avg_first_response_seconds == null ? null : Math.round(l.avg_first_response_seconds),
    sem: l.sem_resposta,
  }));
}

describe("fn_channel_metrics — régua da irmã, no banco real", () => {
  it("manager vê a organização: S1 = 2 conversas, média 90s; S2 arquivado = 1 conversa, vazamento 1, média nula", () => {
    expect(resumo(canais(MANAGER, ORG))).toEqual([
      { id: S1, nome: "Numero Um", arquivado: false, conversas: 2, media: 90, sem: 0 },
      { id: S2, nome: "Numero Dois", arquivado: true, conversas: 1, media: null, sem: 1 },
    ]);
  });

  it("a soma por canal bate com a soma por atendente da irmã (nada engolido)", () => {
    const porCanal = canais(MANAGER, ORG).reduce((s, l) => s + l.conversations_handled, 0);
    const out = sql(`
      ${asRole(MANAGER)}
      select 'ROW:' || coalesce(sum((a->>'conversations_handled')::int), 0)
      from jsonb_array_elements(
        public.fn_attendant_metrics('${ORG}', '${FROM}', '${TO}', null) -> 'attendants'
      ) a;
    `);
    expect(Number(out.split("\n").pop()!.replace(/^ROW:/, ""))).toBe(porCanal);
    expect(porCanal).toBe(3);
  });

  it("agent vê só as PRÓPRIAS conversas, agrupadas por canal (a RLS escopa)", () => {
    expect(resumo(canais(AGENT_A, ORG))).toEqual([
      { id: S1, nome: "Numero Um", arquivado: false, conversas: 1, media: 60, sem: 0 },
      { id: S2, nome: "Numero Dois", arquivado: true, conversas: 1, media: null, sem: 1 },
    ]);
  });

  it("p_owner recorta pelo atendente", () => {
    expect(resumo(canais(MANAGER, ORG, AGENT_B))).toEqual([
      { id: S1, nome: "Numero Um", arquivado: false, conversas: 1, media: 120, sem: 0 },
    ]);
  });

  it("p_org de OUTRA organização devolve [] — nos dois sentidos", () => {
    expect(canais(MANAGER_2, ORG)).toEqual([]);
    expect(canais(MANAGER, ORG_2)).toEqual([]);
    // controle: a organização 2 tem dado, e o dono dela o vê
    expect(resumo(canais(MANAGER_2, ORG_2))).toEqual([
      { id: S_ORG2, nome: "Outra Org", arquivado: false, conversas: 1, media: 20, sem: 0 },
    ]);
  });

  it("anon NÃO executa a função; authenticated executa", () => {
    const out = sql(`
      select has_function_privilege('anon', 'public.fn_channel_metrics(uuid,timestamptz,timestamptz,uuid)', 'execute')
        || '|' ||
        has_function_privilege('authenticated', 'public.fn_channel_metrics(uuid,timestamptz,timestamptz,uuid)', 'execute');
    `);
    expect(out.split("\n").pop()).toBe("false|true");
  });
});
