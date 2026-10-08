import { beforeAll, describe, expect, it } from "vitest";

import {
  GOV_AGENT_A,
  GOV_AGENT_B,
  GOV_CONV_AGENT_B,
  GOV_CONV_UNASSIGNED,
  GOV_MANAGER,
  GOV_ORG,
  GOV_SESSION,
  lastLine,
  seedGov,
  sql,
} from "./gov-helpers";

/**
 * O push de mensagem recebida sai só para as inscrições de quem PODE VER a
 * conversa (migration 0612). A régua é a da RLS de `conversations`
 * (`fn_can_view_conversation`), não uma cópia: os casos abaixo são os mesmos
 * de `gov-5-visibility-scope.test.ts`, agora do lado do envio.
 *
 * GOV_ORG está no default `own_and_unassigned`; GOV_CONV_AGENT_B é do agent B.
 * Conversa de GRUPO está na mesma tabela e sob a mesma RLS: o push de grupo
 * passa pela mesma função, e os casos de grupo abaixo medem isso.
 */

// Namespace exclusivo deste arquivo.
const REVOGADO = "abab0611-1111-4000-8000-000000000001";
const OUTRA_ORG = "abab0611-0000-4000-8000-000000000001";
const CONTATO_GRUPO_SEM_DONO = "abab0611-3333-4000-8000-000000000001";
const CONTATO_GRUPO_DO_A = "abab0611-3333-4000-8000-000000000002";
const GRUPO_SEM_DONO = "abab0611-4444-4000-8000-000000000001";
const GRUPO_DO_A = "abab0611-4444-4000-8000-000000000002";

const SUB = {
  a: "https://push.invariant.test/agente-a",
  b: "https://push.invariant.test/agente-b",
  manager: "https://push.invariant.test/manager",
  revogado: "https://push.invariant.test/revogado",
};

function inscricoesQueVeem(org: string, conversa: string): string[] {
  const out = sql(
    `select coalesce(string_agg(endpoint, ',' order by endpoint), '')
       from public.fn_push_inscricoes_que_veem_a_conversa('${org}', '${conversa}');`,
  );
  const linha = lastLine(out);
  return linha ? linha.split(",") : [];
}

beforeAll(() => {
  seedGov();
  sql(`
    insert into auth.users (id, email) values ('${REVOGADO}', 'push-revogado@invariant.test') on conflict do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at, revoked_at)
      values ('${REVOGADO}', '${GOV_ORG}', 'agent', now(), now()) on conflict do nothing;
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${OUTRA_ORG}', 'push-outra', 'Push Outra Org', 'Push Outra') on conflict do nothing;
    insert into public.push_subscriptions (organization_id, user_id, endpoint, p256dh, auth) values
      ('${GOV_ORG}', '${GOV_AGENT_A}', '${SUB.a}', 'k', 'a'),
      ('${GOV_ORG}', '${GOV_AGENT_B}', '${SUB.b}', 'k', 'a'),
      ('${GOV_ORG}', '${GOV_MANAGER}', '${SUB.manager}', 'k', 'a'),
      ('${GOV_ORG}', '${REVOGADO}', '${SUB.revogado}', 'k', 'a')
    on conflict (endpoint) do nothing;
    insert into public.contacts (id, organization_id, display_name, kind, source) values
      ('${CONTATO_GRUPO_SEM_DONO}', '${GOV_ORG}', 'Push Grupo Sem Dono', 'whatsapp_group', 'whatsapp_group'),
      ('${CONTATO_GRUPO_DO_A}', '${GOV_ORG}', 'Push Grupo do A', 'whatsapp_group', 'whatsapp_group')
    on conflict do nothing;
    insert into public.conversations
      (id, organization_id, contact_id, channel_session_id, status, is_group, group_chat_id, assigned_to_user_id)
    values
      ('${GRUPO_SEM_DONO}', '${GOV_ORG}', '${CONTATO_GRUPO_SEM_DONO}', '${GOV_SESSION}', 'open', true, 'push-sem-dono@g.us', null),
      ('${GRUPO_DO_A}', '${GOV_ORG}', '${CONTATO_GRUPO_DO_A}', '${GOV_SESSION}', 'claimed', true, 'push-do-a@g.us', '${GOV_AGENT_A}')
    on conflict do nothing;
  `);
});

describe("push de mensagem recebida: só a quem pode ver a conversa", () => {
  it("conversa do agent B: B e o manager recebem; o agent A não", () => {
    expect(inscricoesQueVeem(GOV_ORG, GOV_CONV_AGENT_B).sort()).toEqual([SUB.b, SUB.manager].sort());
  });

  it("conversa sem dono em own_and_unassigned: os dois agents e o manager; vínculo revogado nunca", () => {
    expect(inscricoesQueVeem(GOV_ORG, GOV_CONV_UNASSIGNED).sort()).toEqual(
      [SUB.a, SUB.b, SUB.manager].sort(),
    );
  });

  it("conversa pedida por outra organização: ninguém", () => {
    expect(inscricoesQueVeem(OUTRA_ORG, GOV_CONV_AGENT_B)).toEqual([]);
  });

  // Na MESMA transação, como o PostgREST chama: fora dela o set_config local
  // já se desfaria sozinho e o caso passaria sem medir nada. Sem `commit` de
  // propósito: o psql imprimiria "COMMIT" como última linha. O laço da função
  // segue `order by user_id`: o último inscrito é o manager, nunca o agent A
  // que chama aqui — sem restaurar, as claims sairiam com o sub do manager.
  it("devolve as claims de quem chamou intactas", () => {
    const out = sql(`
      begin;
      select set_config('request.jwt.claims', '{"sub":"${GOV_AGENT_A}"}', true);
      select count(*) from public.fn_push_inscricoes_que_veem_a_conversa('${GOV_ORG}', '${GOV_CONV_AGENT_B}');
      select current_setting('request.jwt.claims') || '|' || auth.uid()::text;
    `);
    expect(lastLine(out)).toBe(`{"sub":"${GOV_AGENT_A}"}|${GOV_AGENT_A}`);
  });

  it("só o service role executa", () => {
    const out = sql(`
      select string_agg(r, ',' order by r) from unnest(array['anon','authenticated','service_role']) r
       where has_function_privilege(r, 'public.fn_push_inscricoes_que_veem_a_conversa(uuid, uuid)', 'execute');
    `);
    expect(lastLine(out)).toBe("service_role");
  });

  it("grupo sem dono em own_and_unassigned: os dois agents e o manager", () => {
    expect(inscricoesQueVeem(GOV_ORG, GRUPO_SEM_DONO).sort()).toEqual([SUB.a, SUB.b, SUB.manager].sort());
  });

  // Daqui para baixo muda o visibility_mode do GOV_ORG (cada arquivo tem banco
  // próprio); os casos rodam em ordem.
  it("conversa sem dono em 'own': só o manager", () => {
    definirModo("own");
    expect(inscricoesQueVeem(GOV_ORG, GOV_CONV_UNASSIGNED)).toEqual([SUB.manager]);
  });

  it("grupo em 'own': o agent sem acesso não recebe; o dono e o manager recebem", () => {
    definirModo("own");
    expect(inscricoesQueVeem(GOV_ORG, GRUPO_SEM_DONO)).toEqual([SUB.manager]);
    expect(inscricoesQueVeem(GOV_ORG, GRUPO_DO_A).sort()).toEqual([SUB.a, SUB.manager].sort());
  });

  it("conversa de outro agent em 'all': todos os membros ativos; vínculo revogado nunca", () => {
    definirModo("all");
    expect(inscricoesQueVeem(GOV_ORG, GOV_CONV_AGENT_B).sort()).toEqual([SUB.a, SUB.b, SUB.manager].sort());
  });
});

function definirModo(modo: "own" | "all"): void {
  sql(`update public.organizations set settings = coalesce(settings, '{}'::jsonb) || '{"visibility_mode":"${modo}"}'
        where id = '${GOV_ORG}';`);
}
