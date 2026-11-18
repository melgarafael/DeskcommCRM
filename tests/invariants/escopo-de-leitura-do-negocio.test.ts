import { beforeAll, describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

/**
 * #4323 — o funil não pode custar por linha no RLS.
 *
 * A policy `crm_leads_select` chamava `fn_can_view_lead(organization_id,
 * owner_user_id)` em TODA linha candidata — função `stable security definer set
 * search_path = public`, que o Postgres não inlina e que refaz
 * `fn_user_role_in_org()` (e com ela `fn_support_context()`) por linha. Medido
 * pelo autor da issue: 3 a 7 ms por negócio, ~3,8 s num funil de 3.901. Agora o
 * escopo é resolvido em conjunto (`fn_lead_scope()`), uma vez por consulta, no
 * molde de `fn_conversation_scope()` (0726 / #3090).
 *
 * Este arquivo prende as pontas do conserto:
 *
 *  1. a VISIBILIDADE é idêntica à da régua antiga — as DUAS formulações rodam
 *     sobre a MESMA fixture e o conjunto de linhas é comparado linha a linha, na
 *     matriz de papel × `visibility_mode`: plataforma, admin, manager e viewer da
 *     organização, agent em `own`/`own_and_unassigned`/`all`/modo inválido,
 *     settings vazio, membro com vínculo revogado, organização alheia e uma
 *     sessão de suporte ATIVA. `fn_can_view_lead` segue sendo a fonte da verdade
 *     da escada para os outros consumidores; se as duas divergirem no futuro,
 *     este teste fica vermelho;
 *  2. as quatro FILHAS (`crm_lead_activities`, `crm_lead_links`,
 *     `email_cadence_enrollments`, `email_cadence_events`) seguem o MESMO
 *     conjunto do negócio-pai;
 *  3. o custo não voltou a ser por linha — gate textual no `qual` das policies e
 *     no plano da contagem;
 *  4. `fn_can_view_lead` continua existindo com os MESMOS grants (PUBLIC e anon
 *     revogados, authenticated e service_role com EXECUTE).
 *
 * Namespace 9e5c (cada invariante tem banco próprio).
 */

const ORG_OWN = "9e5c0001-0000-4000-8000-000000000000"; // visibility_mode = 'own'
const ORG_FILA = "9e5c0002-0000-4000-8000-000000000000"; // visibility_mode = 'own_and_unassigned'
const ORG_ALHEIA = "9e5c0003-0000-4000-8000-000000000000"; // visibility_mode = 'own'
const ORG_PADRAO = "9e5c0004-0000-4000-8000-000000000000"; // settings {} ⇒ default 'own_and_unassigned'
const ORG_TUDO = "9e5c0005-0000-4000-8000-000000000000"; // visibility_mode = 'all'
const ORG_INVALIDO = "9e5c0006-0000-4000-8000-000000000000"; // visibility_mode = 'invalido'

const PLATAFORMA = "9e5c1000-0000-4000-8000-000000000001"; // platform admin
const ADMIN = "9e5c1000-0000-4000-8000-000000000002"; // admin de ORG_OWN
const AGENTE_OWN = "9e5c1000-0000-4000-8000-000000000003"; // agent de ORG_OWN (own)
const AGENTE_FILA = "9e5c1000-0000-4000-8000-000000000004"; // agent de ORG_FILA (own_and_unassigned)
const REVOGADO = "9e5c1000-0000-4000-8000-000000000005"; // vínculo revogado em ORG_OWN (papel nulo)
const FORASTEIRO = "9e5c1000-0000-4000-8000-000000000006"; // agent só de ORG_ALHEIA
const OUTRO = "9e5c1000-0000-4000-8000-000000000007"; // agent nas seis organizações
const VIEWER = "9e5c1000-0000-4000-8000-000000000008"; // viewer de ORG_TUDO ('all')
const VIEWER_OWN = "9e5c1000-0000-4000-8000-00000000000d"; // viewer de ORG_OWN ('own')
const GERENTE = "9e5c1000-0000-4000-8000-000000000009"; // manager de ORG_OWN ('own')
const AGENTE_TUDO = "9e5c1000-0000-4000-8000-00000000000a"; // agent de ORG_TUDO ('all')
const AGENTE_INVALIDO = "9e5c1000-0000-4000-8000-00000000000b"; // agent de ORG_INVALIDO
const SUPORTE = "9e5c1000-0000-4000-8000-00000000000c"; // platform admin com sessão de suporte
const SESSAO_SUPORTE = "9e5c6000-0000-4000-8000-000000000001"; // auth.sessions da sessão acima

type Lead = { id: string; org: string; owner: string | null };

const ORGS = [
  { id: ORG_OWN, settings: `'{"visibility_mode":"own"}'::jsonb` },
  { id: ORG_FILA, settings: `'{"visibility_mode":"own_and_unassigned"}'::jsonb` },
  { id: ORG_ALHEIA, settings: `'{"visibility_mode":"own"}'::jsonb` },
  { id: ORG_PADRAO, settings: `'{}'::jsonb` },
  { id: ORG_TUDO, settings: `'{"visibility_mode":"all"}'::jsonb` },
  { id: ORG_INVALIDO, settings: `'{"visibility_mode":"invalido"}'::jsonb` },
] as const;

/** Id determinístico: org é o primeiro grupo, o ordinal é o último. */
function idLead(org: string, ordinal: number): string {
  return `${org.slice(0, 8)}-0000-4000-8000-${String(ordinal).padStart(12, "0")}`;
}

/**
 * 17 negócios: três por organização (o do agent, o sem responsável e o de
 * outra pessoa), dois na organização de settings vazio, três na de
 * `visibility_mode = 'all'` e três na de modo INVÁLIDO.
 */
const LEADS: Lead[] = [
  { id: idLead(ORG_OWN, 1), org: ORG_OWN, owner: AGENTE_OWN },
  { id: idLead(ORG_OWN, 2), org: ORG_OWN, owner: null },
  { id: idLead(ORG_OWN, 3), org: ORG_OWN, owner: OUTRO },
  { id: idLead(ORG_FILA, 1), org: ORG_FILA, owner: AGENTE_FILA },
  { id: idLead(ORG_FILA, 2), org: ORG_FILA, owner: null },
  { id: idLead(ORG_FILA, 3), org: ORG_FILA, owner: OUTRO },
  { id: idLead(ORG_ALHEIA, 1), org: ORG_ALHEIA, owner: FORASTEIRO },
  { id: idLead(ORG_ALHEIA, 2), org: ORG_ALHEIA, owner: null },
  { id: idLead(ORG_ALHEIA, 3), org: ORG_ALHEIA, owner: OUTRO },
  { id: idLead(ORG_PADRAO, 1), org: ORG_PADRAO, owner: null },
  { id: idLead(ORG_PADRAO, 2), org: ORG_PADRAO, owner: OUTRO },
  // `visibility_mode = 'all'`: aqui quem vê a organização inteira é o MODO, não
  // o papel — viewer e agent entram pela coluna `org_wide_read` do conjunto.
  { id: idLead(ORG_TUDO, 1), org: ORG_TUDO, owner: AGENTE_TUDO },
  { id: idLead(ORG_TUDO, 2), org: ORG_TUDO, owner: OUTRO },
  { id: idLead(ORG_TUDO, 3), org: ORG_TUDO, owner: null },
  // Modo INVÁLIDO: cai no `else false` da escada antiga e, na nova, em nenhuma
  // das duas colunas — só o dono enxerga.
  { id: idLead(ORG_INVALIDO, 1), org: ORG_INVALIDO, owner: AGENTE_INVALIDO },
  { id: idLead(ORG_INVALIDO, 2), org: ORG_INVALIDO, owner: null },
  { id: idLead(ORG_INVALIDO, 3), org: ORG_INVALIDO, owner: OUTRO },
];

const FILHAS = [
  "crm_lead_activities",
  "crm_lead_links",
  "email_cadence_enrollments",
  "email_cadence_events",
] as const;

const POLICIES = [
  "crm_leads_select",
  "crm_lead_activities_select",
  "crm_lead_links_select",
  "email_cadence_enrollments_select",
  "email_cadence_events_select",
] as const;

function lista(saida: string): string[] {
  const ultima = saida.split("\n").pop() ?? "-";
  return ultima === "-" ? [] : ultima.split(",").sort();
}

beforeAll(() => {
  const orgs = ORGS.map(
    (o, i) =>
      `('${o.id}', 's9e5c-${i + 1}', 'S9e5c Org ${i + 1}', 'S9e5c Org ${i + 1}', ${o.settings})`,
  ).join(",\n      ");

  const usuarios = [
    PLATAFORMA,
    ADMIN,
    AGENTE_OWN,
    AGENTE_FILA,
    REVOGADO,
    FORASTEIRO,
    OUTRO,
    VIEWER,
    GERENTE,
    AGENTE_TUDO,
    AGENTE_INVALIDO,
    VIEWER_OWN,
    SUPORTE,
  ]
    .map((u, i) => `('${u}', 'pessoa${i + 1}@s9e5c.test')`)
    .join(",\n      ");

  // Vínculos: o REVOGADO tem a linha de ORG_OWN revogada (papel nulo na escada);
  // a plataforma não é membro de organização nenhuma.
  const vinculos = [
    `('${ADMIN}', '${ORG_OWN}', 'admin', now())`,
    `('${AGENTE_OWN}', '${ORG_OWN}', 'agent', now())`,
    `('${AGENTE_FILA}', '${ORG_FILA}', 'agent', now())`,
    `('${FORASTEIRO}', '${ORG_ALHEIA}', 'agent', now())`,
    `('${OUTRO}', '${ORG_OWN}', 'agent', now())`,
    `('${OUTRO}', '${ORG_FILA}', 'agent', now())`,
    `('${OUTRO}', '${ORG_ALHEIA}', 'agent', now())`,
    `('${OUTRO}', '${ORG_PADRAO}', 'agent', now())`,
    `('${VIEWER}', '${ORG_TUDO}', 'viewer', now())`,
    `('${VIEWER_OWN}', '${ORG_OWN}', 'viewer', now())`,
    `('${AGENTE_TUDO}', '${ORG_TUDO}', 'agent', now())`,
    `('${OUTRO}', '${ORG_TUDO}', 'agent', now())`,
    `('${GERENTE}', '${ORG_OWN}', 'manager', now())`,
    `('${AGENTE_INVALIDO}', '${ORG_INVALIDO}', 'agent', now())`,
    `('${OUTRO}', '${ORG_INVALIDO}', 'agent', now())`,
  ].join(",\n        ");

  const pipelines = ORGS.map(
    (o, i) =>
      `('9e5c200${i + 1}-0000-4000-8000-000000000001', '${o.id}', 'Funil ${i + 1}', 'funil-${i + 1}')`,
  ).join(",\n      ");
  const stages = ORGS.map(
    (o, i) =>
      `('9e5c300${i + 1}-0000-4000-8000-000000000001', '${o.id}', '9e5c200${i + 1}-0000-4000-8000-000000000001', 'Novo', 'novo', 1000)`,
  ).join(",\n      ");
  const contatos = ORGS.map(
    (o, i) => `('9e5c400${i + 1}-0000-4000-8000-000000000001', '${o.id}', 'Contato ${i + 1}')`,
  ).join(",\n      ");
  const cadencias = ORGS.map(
    (o, i) => `('9e5c500${i + 1}-0000-4000-8000-000000000001', '${o.id}', 'Cadencia ${i + 1}')`,
  ).join(",\n      ");

  const indiceOrg = (org: string) => ORGS.findIndex((o) => o.id === org);
  const pipelineDe = (org: string) => `9e5c200${indiceOrg(org) + 1}-0000-4000-8000-000000000001`;
  const stageDe = (org: string) => `9e5c300${indiceOrg(org) + 1}-0000-4000-8000-000000000001`;
  const contatoDe = (org: string) => `9e5c400${indiceOrg(org) + 1}-0000-4000-8000-000000000001`;
  const cadenciaDe = (org: string) => `9e5c500${indiceOrg(org) + 1}-0000-4000-8000-000000000001`;

  const leads = LEADS.map(
    (l) =>
      `('${l.id}', '${l.org}', '${pipelineDe(l.org)}', '${stageDe(l.org)}', 'Negocio ${l.id.slice(-2)}', ${l.owner ? `'${l.owner}'` : "null"})`,
  ).join(",\n      ");

  const atividade = (l: Lead) =>
    `('${l.id.slice(0, 8)}-a000-4000-8000-${l.id.slice(-12)}', '${l.org}', '${l.id}', 'invariant', 'note', '{}'::jsonb)`;
  const vinculo = (l: Lead) =>
    `('${l.id.slice(0, 8)}-b000-4000-8000-${l.id.slice(-12)}', '${l.org}', '${l.id}', 'external', '9e5c9000-0000-4000-8000-000000000001', 'reference')`;
  const inscricao = (l: Lead) =>
    `('${l.id.slice(0, 8)}-c000-4000-8000-${l.id.slice(-12)}', '${l.org}', '${cadenciaDe(l.org)}', '${l.id}', '${contatoDe(l.org)}')`;
  const evento = (l: Lead) =>
    `('${l.id.slice(0, 8)}-d000-4000-8000-${l.id.slice(-12)}', '${l.org}', '${cadenciaDe(l.org)}', '${l.id.slice(0, 8)}-c000-4000-8000-${l.id.slice(-12)}', '${l.id}', 'inscrito')`;

  sql(`
    -- Módulo OPCIONAL de cadências: as tabelas só nascem no provisionador.
    select public.fn_cadencias_provisionar();

    insert into public.organizations (id, slug, legal_name, display_name, settings) values
      ${orgs}
    on conflict (id) do nothing;

    insert into auth.users (id, email) values
      ${usuarios}
    on conflict (id) do nothing;

    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
        ${vinculos}
    on conflict do nothing;

    -- O papel nulo da escada: vínculo revogado. fn_user_role_in_org devolve
    -- null, fn_user_org_ids não devolve a organização, e a régua antiga diz
    -- 'não é membro ⇒ nada' mesmo para o negócio atribuído a ele.
    insert into public.user_organizations (user_id, organization_id, role, accepted_at, revoked_at)
      values ('${REVOGADO}', '${ORG_OWN}', 'agent', now(), now())
    on conflict do nothing;

    insert into public.platform_admins (user_id, granted_by, scope, mfa_required, reason)
      values ('${PLATAFORMA}', '${ADMIN}', 'full', false, 'fixture do invariante #4323'),
             ('${SUPORTE}', '${ADMIN}', 'full', false, 'fixture do invariante #4323 (suporte)')
    on conflict (user_id) do nothing;

    -- Sessão de suporte ATIVA, no molde do GoTrue: a sessão do Auth e a linha do
    -- produto que a amarra à organização. O claims da sessão leva o session_id —
    -- sem ele fn_support_context() devolve null e o caso vira decorativo.
    insert into auth.sessions (id, user_id, aal, not_after)
      values ('${SESSAO_SUPORTE}', '${SUPORTE}', 'aal2', now() + interval '2 hours')
    on conflict (id) do nothing;

    insert into public.platform_support_sessions
      (organization_id, actor_user_id, auth_session_id, access_mode, expires_at)
      values ('${ORG_ALHEIA}', '${SUPORTE}', '${SESSAO_SUPORTE}', 'full', now() + interval '1 hour')
    on conflict do nothing;

    insert into public.crm_pipelines (id, organization_id, name, slug) values
      ${pipelines}
    on conflict (id) do nothing;

    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position) values
      ${stages}
    on conflict (id) do nothing;

    insert into public.contacts (id, organization_id, display_name) values
      ${contatos}
    on conflict (id) do nothing;

    insert into public.email_cadences (id, organization_id, name) values
      ${cadencias}
    on conflict (id) do nothing;

    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title, owner_user_id) values
      ${leads}
    on conflict (id) do nothing;

    insert into public.crm_lead_activities (id, organization_id, lead_id, source_module, type, payload) values
      ${LEADS.map(atividade).join(",\n      ")}
    on conflict (id) do nothing;

    insert into public.crm_lead_links (id, organization_id, lead_id, target_kind, target_id, link_kind) values
      ${LEADS.map(vinculo).join(",\n      ")}
    on conflict (id) do nothing;

    insert into public.email_cadence_enrollments (id, organization_id, cadence_id, lead_id, contact_id) values
      ${LEADS.map(inscricao).join(",\n      ")}
    on conflict (id) do nothing;

    insert into public.email_cadence_events (id, organization_id, cadence_id, enrollment_id, lead_id, tipo) values
      ${LEADS.map(evento).join(",\n      ")}
    on conflict (id) do nothing;
  `);
});

/**
 * Claims do JWT simulado — o MESMO objeto nas duas formulações. Todo mundo entra
 * com `sub`; o SUPORTE entra também com `session_id`, que é o que
 * `fn_support_context()` exige para encontrar a sessão aberta. Sem ele o caso de
 * suporte não exercitaria o caminho de suporte de verdade.
 */
function claimsDe(userId: string): string {
  const claims: Record<string, string> = { sub: userId };
  if (userId === SUPORTE) claims.session_id = SESSAO_SUPORTE;
  return JSON.stringify(claims);
}

/** O que a POLICY nova devolve: role authenticated + claims, como o PostgREST. */
function negocioPelaPolicy(userId: string): string[] {
  return lista(
    sql(`
      set role authenticated;
      select set_config('request.jwt.claims', '${claimsDe(userId)}', false);
      select coalesce(string_agg(id::text, ',' order by id), '-') from public.crm_leads;
    `),
  );
}

/**
 * O que a RÉGUA ANTIGA devolve, com os mesmos claims: a formulação por linha
 * (`fn_can_view_lead`), em sessão de superusuário para que só ela filtre — a RLS
 * não pode esconder a linha de referência.
 */
function negocioPelaReguaAntiga(userId: string): string[] {
  return lista(
    sql(`
      select set_config('request.jwt.claims', '${claimsDe(userId)}', false);
      select coalesce(string_agg(id::text, ',' order by id), '-')
        from public.crm_leads
       where public.fn_can_view_lead(organization_id, owner_user_id);
    `),
  );
}

/** O que cada FILHA devolve (o lead_id de cada linha visível), pela policy. */
function filhosPelaPolicy(userId: string): Record<string, string[]> {
  const saida = sql(`
    set role authenticated;
    select set_config('request.jwt.claims', '${claimsDe(userId)}', false);
    select 'crm_lead_activities=' || coalesce(string_agg(lead_id::text, ',' order by lead_id), '-')
      from public.crm_lead_activities;
    select 'crm_lead_links=' || coalesce(string_agg(lead_id::text, ',' order by lead_id), '-')
      from public.crm_lead_links;
    select 'email_cadence_enrollments=' || coalesce(string_agg(lead_id::text, ',' order by lead_id), '-')
      from public.email_cadence_enrollments;
    select 'email_cadence_events=' || coalesce(string_agg(lead_id::text, ',' order by lead_id), '-')
      from public.email_cadence_events;
  `);
  const resultado: Record<string, string[]> = {};
  for (const linha of saida.split("\n")) {
    const [tabela, valores] = linha.split("=");
    if (!tabela || valores === undefined) continue;
    resultado[tabela] = valores === "-" ? [] : valores.split(",").sort();
  }
  return resultado;
}

const COMBINACOES: Array<{ nome: string; userId: string; esperado: number }> = [
  { nome: "platform admin", userId: PLATAFORMA, esperado: 17 },
  { nome: "admin da organização", userId: ADMIN, esperado: 3 },
  { nome: "manager da organização em visibility_mode = own", userId: GERENTE, esperado: 3 },
  { nome: "viewer em visibility_mode = all", userId: VIEWER, esperado: 3 },
  { nome: "viewer da organização em visibility_mode = own", userId: VIEWER_OWN, esperado: 3 },
  { nome: "agent em visibility_mode = all", userId: AGENTE_TUDO, esperado: 3 },
  { nome: "agent em visibility_mode = own", userId: AGENTE_OWN, esperado: 1 },
  { nome: "agent em visibility_mode = own_and_unassigned", userId: AGENTE_FILA, esperado: 2 },
  { nome: "agent em visibility_mode inválido", userId: AGENTE_INVALIDO, esperado: 1 },
  { nome: "membro com vínculo revogado (papel nulo)", userId: REVOGADO, esperado: 0 },
  { nome: "organização alheia", userId: FORASTEIRO, esperado: 1 },
  { nome: "platform admin em sessão de suporte ativa", userId: SUPORTE, esperado: 17 },
  { nome: "agent em seis organizações, uma de settings vazio (modo ausente)", userId: OUTRO, esperado: 10 },
];

describe("#4323 — escopo de leitura do negócio avaliado uma vez, não por linha", () => {
  it("as duas formulações concordam linha a linha nas treze combinações", () => {
    for (const { nome, userId } of COMBINACOES) {
      expect({ nome, linhas: negocioPelaPolicy(userId) }).toEqual({
        nome,
        linhas: negocioPelaReguaAntiga(userId),
      });
    }
  });

  it("pina a escada em números explícitos", () => {
    // 17 negócios seedados: 3 em ORG_OWN (own), 3 em ORG_FILA
    // (own_and_unassigned), 3 em ORG_ALHEIA (own), 2 em ORG_PADRAO (settings
    // vazio ⇒ default own_and_unassigned), 3 em ORG_TUDO ('all') e 3 em
    // ORG_INVALIDO (modo inválido ⇒ só o dono). Os números são a leitura da
    // escada da 0036, não uma cópia da função.
    for (const { nome, userId, esperado } of COMBINACOES) {
      expect({ nome, total: negocioPelaPolicy(userId).length }).toEqual({ nome, total: esperado });
    }
  });

  it("mode = 'all' abre a organização para viewer e agent, e só para ela", () => {
    const daOrgTudo = LEADS.filter((l) => l.org === ORG_TUDO)
      .map((l) => l.id)
      .sort();
    expect(negocioPelaPolicy(VIEWER)).toEqual(daOrgTudo);
    expect(negocioPelaPolicy(AGENTE_TUDO)).toEqual(daOrgTudo);
  });

  it("modo inválido NÃO abre a organização: só o dono enxerga", () => {
    // A escada antiga cai no `else false`; a nova não liga nem `org_wide_read`
    // nem `sees_unassigned`. Se alguém trocar o conjunto por `mode <> 'own'`,
    // este caso (o sem responsável e o do colega) fica visível e cai aqui.
    expect(negocioPelaPolicy(AGENTE_INVALIDO)).toEqual([idLead(ORG_INVALIDO, 1)]);
  });

  it("a sessão de suporte está realmente ativa e não muda o que a plataforma vê", () => {
    // Sem esta guarda o caso de suporte seria decorativo: é preciso que
    // fn_support_context() encontre a sessão (status 'active') e que ela
    // acrescente a organização do suporte a fn_user_org_ids().
    const contexto = sql(`
      select set_config('request.jwt.claims', '${claimsDe(SUPORTE)}', false);
      select coalesce((public.fn_support_context()->>'status'), 'null') || '|' ||
             (select count(*) from public.fn_user_org_ids() where fn_user_org_ids = '${ORG_ALHEIA}');
    `);
    expect(contexto.split("\n").pop()).toBe("active|1");
    expect(negocioPelaPolicy(SUPORTE)).toEqual(negocioPelaPolicy(PLATAFORMA));
  });

  it("plataforma e admin enxergam a organização inteira, e só ela", () => {
    expect(negocioPelaPolicy(ADMIN)).toEqual(
      LEADS.filter((l) => l.org === ORG_OWN)
        .map((l) => l.id)
        .sort(),
    );
    expect(negocioPelaPolicy(PLATAFORMA)).toHaveLength(LEADS.length);
  });

  it("organização alheia é invisível: o dono de lead em outra organização não vaza", () => {
    // AGENTE_OWN é dono de um negócio em ORG_OWN e não é membro de ORG_ALHEIA
    // nem de ORG_FILA — nada de fora da própria organização aparece.
    for (const lead of negocioPelaPolicy(AGENTE_OWN)) {
      expect(LEADS.find((l) => l.id === lead)?.org).toBe(ORG_OWN);
    }
    // O revogado é dono do negócio? Não: ele não tem nenhum; o que se prova é que
    // o vínculo revogado não abre nem o negócio sem responsável nem o da org.
    expect(negocioPelaPolicy(REVOGADO)).toEqual([]);
  });

  it("as quatro filhas seguem o MESMO conjunto do negócio-pai", () => {
    for (const { nome, userId } of COMBINACOES) {
      const visiveis = negocioPelaPolicy(userId);
      const filhas = filhosPelaPolicy(userId);
      for (const tabela of FILHAS) {
        expect({ nome, tabela, leads: filhas[tabela] }).toEqual({ nome, tabela, leads: visiveis });
      }
    }
  });

  it("a policy nova não referencia fn_can_view_lead (gate textual)", () => {
    for (const policy of POLICIES) {
      const qual = sql(`
        select coalesce(qual, '')
          from pg_policies
         where schemaname = 'public' and policyname = '${policy}';
      `);
      expect({ policy, tem: qual.includes("fn_can_view_lead") }).toEqual({ policy, tem: false });
      expect({ policy, usa: qual.includes("fn_lead_scope") }).toEqual({ policy, usa: true });
    }
  });

  it("o plano da contagem não chama a função por linha", () => {
    const saida = sql(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${AGENTE_OWN}"}', false);
      explain (analyze, format json, costs off) select count(*) from public.crm_leads;
    `);
    const plano = saida.slice(saida.indexOf("["));
    expect(plano).not.toContain("fn_can_view_lead");
    expect(plano).toContain("fn_lead_scope");
  });

  it("fn_can_view_lead continua com o mesmo contrato e os mesmos grants", () => {
    const grants = sql(`
      select has_function_privilege('authenticated', 'public.fn_can_view_lead(uuid,uuid)', 'EXECUTE')::text
             || '|' ||
             has_function_privilege('service_role', 'public.fn_can_view_lead(uuid,uuid)', 'EXECUTE')::text
             || '|' ||
             (select count(*) from aclexplode(p.proacl) a where a.grantee = 0)::text
        from pg_proc p
       where p.oid = 'public.fn_can_view_lead(uuid,uuid)'::regprocedure;
    `);
    expect(grants.split("\n").pop()).toBe("true|true|0");

    // O contrato é o da 0036/9090: dois argumentos, stable e definer.
    const contrato = sql(`
      select p.provolatile::text || '|' || p.prosecdef::text || '|' ||
             pg_get_function_identity_arguments(p.oid)
        from pg_proc p
       where p.oid = 'public.fn_can_view_lead(uuid,uuid)'::regprocedure;
    `);
    expect(contrato.split("\n").pop()).toBe("s|true|p_org uuid, p_owner_user_id uuid");
  });
});
