/**
 * #4019 — O NEGÓCIO ABERTO DO CONTATO ACOMPANHA O DONO DA CONVERSA, POR TODOS OS
 * CAMINHOS QUE ATRIBUEM.
 *
 * ─── O defeito, medido ──────────────────────────────────────────────────────
 *
 * O #3177 (PR #3216) levou o negócio aberto ao transferir/assumir PELA TELA: a
 * régua `sincronizarNegocioAbertoDoContato` rodava nas rotas, com o cliente da
 * sessão (RLS ligada). Levantamento do relator: 14 de 46 conversas com dono
 * tinham negócio aberto com responsável DIFERENTE do dono da conversa (ou sem
 * responsável). A transferência FORA da tela — `crm_assign_conversation`
 * (MCP), automação e chamadas diretas de `fn_conversation_assign` — não
 * passava por régua nenhuma.
 *
 * ─── A regra (doc 178, letra B; reafirmada no doc 267, letra A) ────────────
 *
 *   · TRANSFERIR leva o negócio aberto do contato, dentro da permissão de quem
 *     clicou (a mesma de `crm_leads_update`), com a exceção do #4371: quando
 *     quem transfere é o DONO ATUAL do card, o card vai junto mesmo para role
 *     `agent` na visibilidade padrão — ele está entregando o próprio
 *     atendimento de propósito (caminho 1); gestor leva; o servidor (MCP,
 *     automação) leva (caminho 2);
 *   · Assumir, Iniciar conversa, a fila automática e a passagem só dão dono a
 *     negócio SEM responsável — nunca tiram de um colega (caminho 3, fila).
 *
 * ─── O que este arquivo prova (Postgres real, `pnpm test:db`) ───────────────
 *
 * Os caminhos, com o `select` LITERAL dos dois donos (conversa e negócio);
 * e os seis lados opostos que a mudança não pode quebrar: contato sem negócio
 * aberto não ganha card criado; negócio ganho e perdido não são tocados; outra
 * organização não é tocada; "Iniciar conversa" continua só preenchendo card SEM
 * responsável; quem recebe a conversa passa a ver o card e o terceiro continua
 * sem vê-lo (e card de colega que o chamador não enxerga não se move); e
 * A→B→C termina em C sem `lead.assigned` a mais.
 *
 * E as duas portas que passam conversas com `'transfer'` sem sessão — a troca
 * de carteira e a passagem de conversas do contato — não levam negócio que já
 * tem dono (#2591).
 *
 * O caminho 4 da issue (contato com MAIS DE UM negócio aberto) NÃO é consertado
 * aqui: é decisão de produto. O caso existe para provar que, com dois abertos,
 * nada é tocado — e que ninguém escolhe por adivinhação.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { lastLine, sql } from "./gov-helpers";

const ORG = "dddddddd-0000-4000-8000-000000000001";
const OUTRA_ORG = "dddddddd-0000-4000-8000-000000000002";

const A = "dddddddd-1111-4000-8000-000000000001"; // atendente que transfere
const B = "dddddddd-1111-4000-8000-000000000002"; // atendente que recebe
const C = "dddddddd-1111-4000-8000-000000000003"; // terceiro (não enxerga card de A)
const GESTOR = "dddddddd-1111-4000-8000-000000000004";
const FORA = "dddddddd-1111-4000-8000-000000000005"; // membro da OUTRA organização

const SESSAO = "dddddddd-2222-4000-8000-000000000001";
const SESSAO_OUTRA = "dddddddd-2222-4000-8000-000000000002";
const PIPELINE = "dddddddd-5555-4000-8000-000000000001";
const ETAPA = "dddddddd-5555-4000-8000-000000000002";
const PIPELINE_OUTRA = "dddddddd-5555-4000-8000-000000000003";
const ETAPA_OUTRA = "dddddddd-5555-4000-8000-000000000004";

/** Um contato por caso: um caso não contamina o outro (1 conversa por par). */
const CT = {
  atendenteTransfere: "dddddddd-3333-4000-8000-000000000001",
  foraDaTela: "dddddddd-3333-4000-8000-000000000002",
  assumir: "dddddddd-3333-4000-8000-000000000003",
  semNegocio: "dddddddd-3333-4000-8000-000000000004",
  ganho: "dddddddd-3333-4000-8000-000000000005",
  perdido: "dddddddd-3333-4000-8000-000000000006",
  iniciarComDono: "dddddddd-3333-4000-8000-000000000007",
  iniciarLivre: "dddddddd-3333-4000-8000-000000000008",
  escada: "dddddddd-3333-4000-8000-000000000009",
  cardInvisivel: "dddddddd-3333-4000-8000-00000000000a",
  doisAbertos: "dddddddd-3333-4000-8000-00000000000b",
  outraOrganizacao: "dddddddd-3333-4000-8000-00000000000c",
  gestorTransfere: "dddddddd-3333-4000-8000-00000000000d",
  filaComDono: "dddddddd-3333-4000-8000-00000000000e",
  filaLivre: "dddddddd-3333-4000-8000-00000000000f",
  transfereSemDono: "dddddddd-3333-4000-8000-000000000010",
  continua: "dddddddd-3333-4000-8000-000000000011",
  daIa: "dddddddd-3333-4000-8000-000000000012",
  carteira: "dddddddd-3333-4000-8000-000000000013",
  passagem: "dddddddd-3333-4000-8000-000000000014",
  passagemLivre: "dddddddd-3333-4000-8000-000000000015",
  /** #4371 controle: a conversa é do COLEGA, e o card é do A. */
  conversaDoColega: "dddddddd-3333-4000-8000-000000000016",
} as const;

const CONV = {
  atendenteTransfere: "dddddddd-4444-4000-8000-000000000001",
  foraDaTela: "dddddddd-4444-4000-8000-000000000002",
  assumir: "dddddddd-4444-4000-8000-000000000003",
  semNegocio: "dddddddd-4444-4000-8000-000000000004",
  ganho: "dddddddd-4444-4000-8000-000000000005",
  perdido: "dddddddd-4444-4000-8000-000000000006",
  iniciarComDono: "dddddddd-4444-4000-8000-000000000007",
  iniciarLivre: "dddddddd-4444-4000-8000-000000000008",
  escada: "dddddddd-4444-4000-8000-000000000009",
  cardInvisivel: "dddddddd-4444-4000-8000-00000000000a",
  doisAbertos: "dddddddd-4444-4000-8000-00000000000b",
  outraOrganizacao: "dddddddd-4444-4000-8000-00000000000c",
  gestorTransfere: "dddddddd-4444-4000-8000-00000000000d",
  filaComDono: "dddddddd-4444-4000-8000-00000000000e",
  filaLivre: "dddddddd-4444-4000-8000-00000000000f",
  transfereSemDono: "dddddddd-4444-4000-8000-000000000010",
  /** A conversa que entra na fila, no número de A. */
  continuaNoNumeroDeA: "dddddddd-4444-4000-8000-000000000011",
  /** A conversa do MESMO contato que já existe no número de B (#3732). */
  continuaNoNumeroDeB: "dddddddd-4444-4000-8000-000000000012",
  daIa: "dddddddd-4444-4000-8000-000000000013",
  carteira: "dddddddd-4444-4000-8000-000000000014",
  passagem: "dddddddd-4444-4000-8000-000000000015",
  passagemLivre: "dddddddd-4444-4000-8000-000000000016",
  /** #4371 controle: conversa do colega B, card do A. */
  conversaDoColega: "dddddddd-4444-4000-8000-000000000017",
} as const;

const NEG = {
  atendenteTransfere: "dddddddd-6666-4000-8000-000000000001",
  foraDaTela: "dddddddd-6666-4000-8000-000000000002",
  assumir: "dddddddd-6666-4000-8000-000000000003",
  ganho: "dddddddd-6666-4000-8000-000000000004",
  perdido: "dddddddd-6666-4000-8000-000000000005",
  presoNoDono: "dddddddd-6666-4000-8000-000000000006",
  livre: "dddddddd-6666-4000-8000-000000000007",
  escada: "dddddddd-6666-4000-8000-000000000008",
  doColega: "dddddddd-6666-4000-8000-000000000009",
  doisAbertosA: "dddddddd-6666-4000-8000-00000000000a",
  doisAbertosB: "dddddddd-6666-4000-8000-00000000000b",
  outraOrganizacao: "dddddddd-6666-4000-8000-00000000000c",
  gestorTransfere: "dddddddd-6666-4000-8000-00000000000d",
  filaComDono: "dddddddd-6666-4000-8000-00000000000e",
  filaLivre: "dddddddd-6666-4000-8000-00000000000f",
  transfereSemDono: "dddddddd-6666-4000-8000-000000000010",
  continua: "dddddddd-6666-4000-8000-000000000011",
  daIa: "dddddddd-6666-4000-8000-000000000012",
  carteira: "dddddddd-6666-4000-8000-000000000013",
  passagem: "dddddddd-6666-4000-8000-000000000014",
  passagemLivre: "dddddddd-6666-4000-8000-000000000015",
  /** #4371 controle: card do A (dono), na conversa que é do B. */
  conversaDoColega: "dddddddd-6666-4000-8000-000000000016",
} as const;

/** Agente de IA dono de um card: "sem responsável" exige também owner_agent_id nulo. */
const AGENTE_IA = "dddddddd-8888-4000-8000-000000000001";

/** Dois números com dono (política de roteamento), para a conversa que continua. */
const SESSAO_DE_A = "dddddddd-2222-4000-8000-000000000003";
const SESSAO_DE_B = "dddddddd-2222-4000-8000-000000000004";
const POLITICA_DE_A = "dddddddd-7777-4000-8000-000000000001";
const POLITICA_DE_B = "dddddddd-7777-4000-8000-000000000002";

/** Os dois donos, literais: conversa e negócio. */
function donoDaConversa(conversa: string): string {
  return lastLine(
    sql(`select coalesce(assigned_to_user_id::text, 'SEM_DONO') from public.conversations where id = '${conversa}';`),
  );
}

function donoDoNegocio(negocio: string): string {
  return lastLine(
    sql(`select coalesce(owner_user_id::text, 'SEM_DONO') from public.crm_leads where id = '${negocio}';`),
  );
}

function quantosNegocios(contato: string): number {
  return Number(
    lastLine(
      sql(`select count(*) from public.crm_leads where organization_id = '${ORG}' and contact_id = '${contato}';`),
    ),
  );
}

/** Quantos cards o usuário ENXERGA pela RLS de crm_leads (a visibilidade real). */
function quantosEnxerga(usuario: string, negocio: string): number {
  return Number(
    lastLine(
      sql(`
        set role authenticated;
        select set_config('request.jwt.claims', '{"sub":"${usuario}"}', false);
        select count(*) from public.crm_leads where id = '${negocio}';
      `),
    ),
  );
}

/**
 * A chamada como as rotas fazem: sessão de pessoa (auth.uid()) ou runtime /
 * servidor (service role, auth.uid() nulo — é o client do MCP). Sem o 8º
 * argumento por padrão, de propósito: é a assinatura que TODO chamador de hoje
 * usa, e é ela que o defeito habita.
 */
function atribui(p: {
  como: string | null; // null = service role (MCP / automação)
  organizacao?: string;
  conversa: string;
  para: string | null;
  motivo?: string;
  esperado?: string | null;
  trava?: boolean;
  soSemDono?: boolean;
}): void {
  const args = [
    `'${p.organizacao ?? ORG}'`,
    `'${p.conversa}'`,
    p.para ? `'${p.para}'` : "null",
    `'${p.motivo ?? "transfer"}'`,
    p.esperado === undefined || p.esperado === null ? "null" : `'${p.esperado}'`,
    p.trava ? "true" : "false",
  ];
  // O 8º argumento mora DEPOIS do `p_source_job_id` (7º) — o slot do turno
  // autônomo, que aqui é sempre nulo.
  if (p.soSemDono !== undefined) args.push("null", p.soSemDono ? "true" : "false");

  const sessao =
    p.como === null
      ? "set role service_role;"
      : `set role authenticated;\n select set_config('request.jwt.claims', '{"sub":"${p.como}"}', false);`;
  sql(`${sessao}
    select public.fn_conversation_assign(${args.join(", ")});`);
}

function eventosDeAtribuicao(negocio: string): number {
  return Number(
    lastLine(
      sql(`select count(*) from public.event_log
            where organization_id = '${ORG}' and event_type = 'lead.assigned'
              and payload ->> 'lead_id' = '${negocio}';`),
    ),
  );
}

function conversaNova(id: string, contato: string, dono: string | null, sessao: string = SESSAO): void {
  sql(`
    insert into public.conversations
      (id, organization_id, contact_id, channel_session_id, status, assigned_to_user_id, assigned_at)
    values ('${id}', '${ORG}', '${contato}', '${sessao}', '${dono ? "claimed" : "open"}',
            ${dono ? `'${dono}'` : "null"}, ${dono ? "now()" : "null"});
  `);
}

function negocioNovo(p: {
  id: string;
  contato: string;
  dono: string | null;
  status?: string;
  motivoDaPerda?: string;
  organizacao?: string;
  pipeline?: string;
  etapa?: string;
}): void {
  const status = p.status ?? "open";
  sql(`
    insert into public.crm_leads
      (id, organization_id, pipeline_id, stage_id, title, contact_id, status, lost_reason,
       closed_at, owner_user_id, owner_kind)
    values ('${p.id}', '${p.organizacao ?? ORG}', '${p.pipeline ?? PIPELINE}', '${p.etapa ?? ETAPA}',
            'Negócio do caso', '${p.contato}', '${status}',
            ${p.motivoDaPerda ? `'${p.motivoDaPerda}'` : "null"},
            ${status === "open" ? "null" : "now()"},
            ${p.dono ? `'${p.dono}'` : "null"}, ${p.dono ? "'user'" : "null"});
  `);
}

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${A}', 'acompanha-a@invariant.test'),
      ('${B}', 'acompanha-b@invariant.test'),
      ('${C}', 'acompanha-c@invariant.test'),
      ('${GESTOR}', 'acompanha-gestor@invariant.test'),
      ('${FORA}', 'acompanha-fora@invariant.test')
    on conflict (id) do nothing;

    insert into public.organizations (id, slug, legal_name, display_name, settings) values
      ('${ORG}', 'acompanha-o-dono-inv', 'Acompanha Invariant Org', 'Acompanha Inv',
       '{"visibility_mode":"own_and_unassigned"}'::jsonb),
      ('${OUTRA_ORG}', 'acompanha-o-dono-outra', 'Acompanha Outra Org', 'Acompanha Outra',
       '{"visibility_mode":"own_and_unassigned"}'::jsonb)
    on conflict (id) do nothing;

    update public.organizations
       set settings = coalesce(settings, '{}'::jsonb) || '{"visibility_mode":"own_and_unassigned"}'::jsonb
     where id in ('${ORG}', '${OUTRA_ORG}');

    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${A}', '${ORG}', 'agent', now()),
      ('${B}', '${ORG}', 'agent', now()),
      ('${C}', '${ORG}', 'agent', now()),
      ('${GESTOR}', '${ORG}', 'manager', now()),
      ('${FORA}', '${OUTRA_ORG}', 'agent', now())
    on conflict (user_id, organization_id) do update
      set role = excluded.role, revoked_at = null, accepted_at = now();

    do $org$ begin
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
        values ('${SESSAO}', '${ORG}', 'acompanha-o-dono-inv', '\\x00'::bytea);
    exception when unique_violation then null; end $org$;

    do $org$ begin
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
        values ('${SESSAO_OUTRA}', '${OUTRA_ORG}', 'acompanha-o-dono-outra', '\\x00'::bytea);
    exception when unique_violation then null; end $org$;

    insert into public.crm_pipelines (id, organization_id, name, slug) values
      ('${PIPELINE}', '${ORG}', 'Acompanha Invariant', 'acompanha-o-dono-inv'),
      ('${PIPELINE_OUTRA}', '${OUTRA_ORG}', 'Acompanha Outra', 'acompanha-o-dono-outra')
    on conflict (id) do nothing;

    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position) values
      ('${ETAPA}', '${ORG}', '${PIPELINE}', 'Novo', 'novo-acompanha', 1000),
      ('${ETAPA_OUTRA}', '${OUTRA_ORG}', '${PIPELINE_OUTRA}', 'Novo', 'novo-acompanha-outra', 1000)
    on conflict (id) do nothing;

    insert into public.contacts (id, organization_id, display_name) values
      ('${CT.atendenteTransfere}', '${ORG}', 'Contato Atendente Transfere'),
      ('${CT.foraDaTela}', '${ORG}', 'Contato Fora Da Tela'),
      ('${CT.assumir}', '${ORG}', 'Contato Assumir'),
      ('${CT.semNegocio}', '${ORG}', 'Contato Sem Negocio'),
      ('${CT.ganho}', '${ORG}', 'Contato Ganho'),
      ('${CT.perdido}', '${ORG}', 'Contato Perdido'),
      ('${CT.iniciarComDono}', '${ORG}', 'Contato Iniciar Com Dono'),
      ('${CT.iniciarLivre}', '${ORG}', 'Contato Iniciar Livre'),
      ('${CT.escada}', '${ORG}', 'Contato Escada'),
      ('${CT.cardInvisivel}', '${ORG}', 'Contato Card Invisivel'),
      ('${CT.doisAbertos}', '${ORG}', 'Contato Dois Abertos'),
      ('${CT.outraOrganizacao}', '${OUTRA_ORG}', 'Contato Outra Organizacao'),
      ('${CT.gestorTransfere}', '${ORG}', 'Contato Gestor Transfere'),
      ('${CT.filaComDono}', '${ORG}', 'Contato Fila Com Dono'),
      ('${CT.filaLivre}', '${ORG}', 'Contato Fila Livre'),
      ('${CT.transfereSemDono}', '${ORG}', 'Contato Transfere Sem Dono'),
      ('${CT.continua}', '${ORG}', 'Contato Continua'),
      ('${CT.daIa}', '${ORG}', 'Contato Da IA'),
      ('${CT.carteira}', '${ORG}', 'Contato Carteira'),
      ('${CT.passagem}', '${ORG}', 'Contato Passagem'),
      ('${CT.passagemLivre}', '${ORG}', 'Contato Passagem Livre'),
      ('${CT.conversaDoColega}', '${ORG}', 'Contato Conversa Do Colega')
    on conflict (id) do nothing;

    insert into public.ai_agents (id, organization_id, name, system_prompt) values
      ('${AGENTE_IA}', '${ORG}', 'Agente Acompanha O Dono Inv', 'invariante')
    on conflict (id) do nothing;

    insert into public.channel_sessions
      (id, organization_id, provider, waha_session_name, webhook_secret_encrypted, status)
    values
      ('${SESSAO_DE_A}', '${ORG}', 'waha', 'acompanha-o-dono-numero-a', '\\x00'::bytea, 'WORKING'),
      ('${SESSAO_DE_B}', '${ORG}', 'waha', 'acompanha-o-dono-numero-b', '\\x00'::bytea, 'WORKING')
    on conflict (id) do update set status = 'WORKING', archived_at = null, metadata = '{}'::jsonb;

    insert into public.channel_routing_policies (id, organization_id, channel_session_id) values
      ('${POLITICA_DE_A}', '${ORG}', '${SESSAO_DE_A}'),
      ('${POLITICA_DE_B}', '${ORG}', '${SESSAO_DE_B}')
    on conflict (id) do nothing;

    insert into public.channel_routing_responsibles (organization_id, policy_id, user_id) values
      ('${ORG}', '${POLITICA_DE_A}', '${A}'),
      ('${ORG}', '${POLITICA_DE_B}', '${B}')
    on conflict do nothing;
  `);

  // Caminho 1 — Atendente transfere com `own_and_unassigned`.
  conversaNova(CONV.atendenteTransfere, CT.atendenteTransfere, A);
  negocioNovo({ id: NEG.atendenteTransfere, contato: CT.atendenteTransfere, dono: A });

  // Caminho 2 — transferência fora da tela (MCP / chamada direta).
  conversaNova(CONV.foraDaTela, CT.foraDaTela, A);
  negocioNovo({ id: NEG.foraDaTela, contato: CT.foraDaTela, dono: A });

  // Caminho 3 — Assumir do Inbox: conversa livre, card com quem não atende mais.
  conversaNova(CONV.assumir, CT.assumir, null);
  negocioNovo({ id: NEG.assumir, contato: CT.assumir, dono: A });

  // Lado oposto (a) — contato sem negócio aberto: conversa, e nada de card.
  conversaNova(CONV.semNegocio, CT.semNegocio, A);

  // Lado oposto (b) — negócio GANHO e negócio PERDIDO não são tocados.
  conversaNova(CONV.ganho, CT.ganho, A);
  negocioNovo({ id: NEG.ganho, contato: CT.ganho, dono: A, status: "won" });
  conversaNova(CONV.perdido, CT.perdido, A);
  negocioNovo({
    id: NEG.perdido,
    contato: CT.perdido,
    dono: A,
    status: "lost",
    motivoDaPerda: "requested_by_customer",
  });

  // Lado oposto (d) — "Iniciar conversa": um card com dono e um sem dono.
  conversaNova(CONV.iniciarComDono, CT.iniciarComDono, null);
  negocioNovo({ id: NEG.presoNoDono, contato: CT.iniciarComDono, dono: A });
  conversaNova(CONV.iniciarLivre, CT.iniciarLivre, null);
  negocioNovo({ id: NEG.livre, contato: CT.iniciarLivre, dono: null });

  // Lado oposto (e) — o card é do C, e A (own_and_unassigned) não o enxerga.
  conversaNova(CONV.cardInvisivel, CT.cardInvisivel, A);
  negocioNovo({ id: NEG.doColega, contato: CT.cardInvisivel, dono: C });

  // Caminho 4 da issue (decisão de produto) — dois abertos: nada é tocado.
  conversaNova(CONV.doisAbertos, CT.doisAbertos, A);
  negocioNovo({ id: NEG.doisAbertosA, contato: CT.doisAbertos, dono: A });
  negocioNovo({ id: NEG.doisAbertosB, contato: CT.doisAbertos, dono: null });

  // Lado oposto (c) — a outra organização, com o MESMO cenário.
  sql(`
    insert into public.conversations
      (id, organization_id, contact_id, channel_session_id, status, assigned_to_user_id, assigned_at)
    values ('${CONV.outraOrganizacao}', '${OUTRA_ORG}', '${CT.outraOrganizacao}', '${SESSAO_OUTRA}',
            'claimed', '${FORA}', now());

    insert into public.crm_leads
      (id, organization_id, pipeline_id, stage_id, title, contact_id, status, owner_user_id, owner_kind)
    values ('${NEG.outraOrganizacao}', '${OUTRA_ORG}', '${PIPELINE_OUTRA}', '${ETAPA_OUTRA}',
            'Negócio da outra organização', '${CT.outraOrganizacao}', 'open', '${FORA}', 'user');
  `);

  // Gestor transfere: o card de A vai para B.
  conversaNova(CONV.gestorTransfere, CT.gestorTransfere, A);
  negocioNovo({ id: NEG.gestorTransfere, contato: CT.gestorTransfere, dono: A });

  // Fila automática: um card com dono e um sem dono.
  conversaNova(CONV.filaComDono, CT.filaComDono, null);
  negocioNovo({ id: NEG.filaComDono, contato: CT.filaComDono, dono: A });
  conversaNova(CONV.filaLivre, CT.filaLivre, null);
  negocioNovo({ id: NEG.filaLivre, contato: CT.filaLivre, dono: null });

  // Transferir conversa SEM dono: o card do C, que A não enxerga, fica.
  conversaNova(CONV.transfereSemDono, CT.transfereSemDono, null);
  negocioNovo({ id: NEG.transfereSemDono, contato: CT.transfereSemDono, dono: C });

  // A conversa que continua (#3732): o contato está no número de A e já tem
  // conversa no número de B, parada (IA silenciada, para ser adotada).
  conversaNova(CONV.continuaNoNumeroDeA, CT.continua, null, SESSAO_DE_A);
  conversaNova(CONV.continuaNoNumeroDeB, CT.continua, null, SESSAO_DE_B);
  sql(`update public.conversations set bot_silenced_until = now() + interval '1 day'
        where id = '${CONV.continuaNoNumeroDeB}';`);
  negocioNovo({ id: NEG.continua, contato: CT.continua, dono: A });

  // O card de um agente de IA: tem responsável, ainda que não seja pessoa.
  conversaNova(CONV.daIa, CT.daIa, null);
  sql(`
    insert into public.crm_leads
      (id, organization_id, pipeline_id, stage_id, title, contact_id, status, owner_agent_id, owner_kind)
    values ('${NEG.daIa}', '${ORG}', '${PIPELINE}', '${ETAPA}', 'Negócio da IA', '${CT.daIa}', 'open',
            '${AGENTE_IA}', 'ai');
  `);

  // A carteira de A, com a conversa e o negócio de A: a troca de carteira
  // para C passa a conversa (porta única, 'transfer', sem sessão).
  conversaNova(CONV.carteira, CT.carteira, A);
  negocioNovo({ id: NEG.carteira, contato: CT.carteira, dono: A });
  sql(`set role service_role;
    select public.fn_definir_carteira_do_cliente('${ORG}', null, '${CT.carteira}', '${A}', 'automacao');`);

  // A passagem de conversas: a conversa e o negócio são de B.
  conversaNova(CONV.passagem, CT.passagem, B);
  negocioNovo({ id: NEG.passagem, contato: CT.passagem, dono: B });

  // A mesma passagem, com o único negócio aberto do contato sem responsável.
  conversaNova(CONV.passagemLivre, CT.passagemLivre, B);
  negocioNovo({ id: NEG.passagemLivre, contato: CT.passagemLivre, dono: null });

  // A escada A→B→C.
  conversaNova(CONV.escada, CT.escada, A);
  negocioNovo({ id: NEG.escada, contato: CT.escada, dono: A });

  // #4371 controle — o A é dono do CARD, mas a conversa é do B.
  conversaNova(CONV.conversaDoColega, CT.conversaDoColega, B);
  negocioNovo({ id: NEG.conversaDoColega, contato: CT.conversaDoColega, dono: A });
});

afterAll(() => {
  sql(`
    delete from public.event_log where organization_id in ('${ORG}', '${OUTRA_ORG}');
    delete from public.conversation_assignment_events where organization_id in ('${ORG}', '${OUTRA_ORG}');
    delete from public.conversations where organization_id in ('${ORG}', '${OUTRA_ORG}');
    delete from public.crm_leads where organization_id in ('${ORG}', '${OUTRA_ORG}');
    delete from public.ai_agents where organization_id = '${ORG}';
    delete from public.channel_routing_responsibles where organization_id = '${ORG}';
    delete from public.channel_routing_policies where organization_id = '${ORG}';
    delete from public.channel_sessions where organization_id in ('${ORG}', '${OUTRA_ORG}');
    delete from public.crm_stages where organization_id in ('${ORG}', '${OUTRA_ORG}');
    delete from public.crm_pipelines where organization_id in ('${ORG}', '${OUTRA_ORG}');
    delete from public.contacts where organization_id in ('${ORG}', '${OUTRA_ORG}');
    delete from public.user_organizations where organization_id in ('${ORG}', '${OUTRA_ORG}');
    delete from public.organizations where id in ('${ORG}', '${OUTRA_ORG}');
    delete from auth.users where id in ('${A}', '${B}', '${C}', '${GESTOR}', '${FORA}');
  `);
});

describe("#4019 — o negócio aberto acompanha o dono da conversa", () => {
  it("#4371 — caminho 1: o DONO do card transfere em own_and_unassigned e o card vai junto", () => {
    expect(donoDaConversa(CONV.atendenteTransfere)).toBe(A);
    expect(donoDoNegocio(NEG.atendenteTransfere)).toBe(A);

    atribui({ como: A, conversa: CONV.atendenteTransfere, para: B });

    const evento = lastLine(
      sql(`select from_user_id::text || '>' || to_user_id::text
             from public.conversation_assignment_events
            where conversation_id = '${CONV.atendenteTransfere}' and reason = 'transfer'
            order by created_at desc limit 1;`),
    );
    expect(evento).toBe(`${A}>${B}`);
    expect(donoDaConversa(CONV.atendenteTransfere)).toBe(B);
    // #4371: na visibilidade padrão, `fn_can_view_lead(A → B)` é falso e o card
    // ficava com quem saiu — a colega não achava o negócio no filtro
    // "Responsável". Quem entrega o atendimento do PRÓPRIO card de propósito não
    // precisa enxergar o destino: o card acompanha.
    expect(donoDoNegocio(NEG.atendenteTransfere)).toBe(B);
  });

  it("#4371 controle: ser dono do CARD não abre a conversa de um colega", () => {
    // A é dono do card, mas a conversa é do B. A visibilidade da CONVERSA barra
    // antes de o negócio ser lido: a chamada responde zero linhas e nada se
    // move. A exceção do #4371 vale na permissão do CARD — nunca como chave
    // para transferir a conversa de outra pessoa.
    expect(quantosEnxerga(A, NEG.conversaDoColega)).toBe(1);

    atribui({ como: A, conversa: CONV.conversaDoColega, para: C });

    expect(donoDaConversa(CONV.conversaDoColega)).toBe(B);
    expect(donoDoNegocio(NEG.conversaDoColega)).toBe(A);
  });

  it("caminho 1, gestor: quem pode entregar o card transfere e o card vai junto", () => {
    expect(donoDoNegocio(NEG.gestorTransfere)).toBe(A);

    atribui({ como: GESTOR, conversa: CONV.gestorTransfere, para: B });

    expect(donoDaConversa(CONV.gestorTransfere)).toBe(B);
    expect(donoDoNegocio(NEG.gestorTransfere)).toBe(B);
  });

  it("caminho 2: transferência fora da tela (service role, como o MCP) leva o card", () => {
    expect(donoDoNegocio(NEG.foraDaTela)).toBe(A);

    atribui({ como: null, conversa: CONV.foraDaTela, para: B });

    expect(donoDaConversa(CONV.foraDaTela)).toBe(B);
    expect(donoDoNegocio(NEG.foraDaTela)).toBe(B);
  });

  it("caminho 3: Assumir do Inbox não tira o card de um colega", () => {
    expect(donoDaConversa(CONV.assumir)).toBe("SEM_DONO");
    expect(donoDoNegocio(NEG.assumir)).toBe(A);

    atribui({ como: B, conversa: CONV.assumir, para: B, motivo: "claim", esperado: null, trava: true });

    expect(donoDaConversa(CONV.assumir)).toBe(B);
    // Doc 178 (B): Assumir só dá dono a negócio SEM responsável.
    expect(donoDoNegocio(NEG.assumir)).toBe(A);
  });

  it("fila automática (servidor, 'routing'): só preenche card sem dono, nunca tira de colega", () => {
    atribui({ como: null, conversa: CONV.filaComDono, para: B, motivo: "routing" });
    atribui({ como: null, conversa: CONV.filaLivre, para: B, motivo: "routing" });

    expect(donoDaConversa(CONV.filaComDono)).toBe(B);
    expect(donoDoNegocio(NEG.filaComDono)).toBe(A);
    expect(donoDaConversa(CONV.filaLivre)).toBe(B);
    expect(donoDoNegocio(NEG.filaLivre)).toBe(B);

    // Card de agente de IA também tem responsável: a fila não o toma.
    atribui({ como: null, conversa: CONV.daIa, para: B, motivo: "routing" });
    expect(donoDaConversa(CONV.daIa)).toBe(B);
    expect(
      lastLine(sql(`select coalesce(owner_agent_id::text, 'SEM_DONO') || '|' || coalesce(owner_user_id::text, 'SEM_DONO')
                      from public.crm_leads where id = '${NEG.daIa}';`)),
    ).toBe(`${AGENTE_IA}|SEM_DONO`);
  });

  it("a conversa que continua no número do dono novo não leva o card que a fila não levaria", () => {
    atribui({ como: null, conversa: CONV.continuaNoNumeroDeA, para: B, motivo: "routing" });

    // A conversa do número de B foi adotada pela chamada interna ('transfer')…
    expect(donoDaConversa(CONV.continuaNoNumeroDeB)).toBe(B);
    expect(donoDaConversa(CONV.continuaNoNumeroDeA)).toBe(B);
    // …e o card do colega ficou: a chamada interna herda a régua da de fora.
    expect(donoDoNegocio(NEG.continua)).toBe(A);
  });

  it("lado oposto (a): contato sem negócio aberto não ganha card criado", () => {
    atribui({ como: A, conversa: CONV.semNegocio, para: B });

    expect(donoDaConversa(CONV.semNegocio)).toBe(B);
    expect(quantosNegocios(CT.semNegocio)).toBe(0);
  });

  it("lado oposto (b): negócio GANHO e PERDIDO não são tocados", () => {
    atribui({ como: A, conversa: CONV.ganho, para: B });
    atribui({ como: A, conversa: CONV.perdido, para: B });

    expect(donoDaConversa(CONV.ganho)).toBe(B);
    expect(donoDaConversa(CONV.perdido)).toBe(B);
    expect(donoDoNegocio(NEG.ganho)).toBe(A);
    expect(donoDoNegocio(NEG.perdido)).toBe(A);
    expect(lastLine(sql(`select status from public.crm_leads where id = '${NEG.ganho}';`))).toBe("won");
    expect(lastLine(sql(`select status from public.crm_leads where id = '${NEG.perdido}';`))).toBe("lost");
  });

  it("lado oposto (d): Iniciar conversa só preenche card SEM responsável", () => {
    // Um único negócio aberto, COM dono: nada é escrito.
    atribui({ como: B, conversa: CONV.iniciarComDono, para: B, motivo: "claim", esperado: null, trava: true, soSemDono: true });
    expect(donoDaConversa(CONV.iniciarComDono)).toBe(B);
    expect(donoDoNegocio(NEG.presoNoDono)).toBe(A);

    // Um único negócio aberto, SEM dono: o dono é preenchido.
    atribui({ como: B, conversa: CONV.iniciarLivre, para: B, motivo: "claim", esperado: null, trava: true, soSemDono: true });
    expect(donoDaConversa(CONV.iniciarLivre)).toBe(B);
    expect(donoDoNegocio(NEG.livre)).toBe(B);
  });

  it("lado oposto (e): quem recebe passa a ver o card; o terceiro continua sem vê-lo", () => {
    // Depois do caminho 1 do gestor (B é o dono): B enxerga, C não.
    expect(donoDoNegocio(NEG.gestorTransfere)).toBe(B);
    expect(quantosEnxerga(B, NEG.gestorTransfere)).toBe(1);
    expect(quantosEnxerga(C, NEG.gestorTransfere)).toBe(0);

    // #4371 controle: o card de um COLEGA que o chamador não enxerga continua
    // sem se mover — a exceção do dono do card não vale para quem não é dono.
    expect(quantosEnxerga(A, NEG.doColega)).toBe(0);
    atribui({ como: A, conversa: CONV.cardInvisivel, para: B });

    expect(donoDaConversa(CONV.cardInvisivel)).toBe(B);
    expect(donoDoNegocio(NEG.doColega)).toBe(C);

    // A mesma conta vale para a conversa que estava SEM dono.
    expect(quantosEnxerga(A, NEG.transfereSemDono)).toBe(0);
    atribui({ como: A, conversa: CONV.transfereSemDono, para: B });

    expect(donoDaConversa(CONV.transfereSemDono)).toBe(B);
    expect(donoDoNegocio(NEG.transfereSemDono)).toBe(C);
  });

  it("lado oposto (c): outra organização não é tocada", () => {
    expect(donoDoNegocio(NEG.outraOrganizacao)).toBe(FORA);

    // Nem por uma chamada de servidor que pede a OUTRA organização para uma
    // conversa desta: o destino é membro de lá, a conversa não é de lá, zero
    // linhas e nada é escrito em nenhum dos dois lados.
    atribui({ como: null, organizacao: OUTRA_ORG, conversa: CONV.atendenteTransfere, para: FORA });

    expect(donoDoNegocio(NEG.outraOrganizacao)).toBe(FORA);
    expect(donoDaConversa(CONV.atendenteTransfere)).toBe(B);
    expect(
      Number(lastLine(sql(`select count(*) from public.conversation_assignment_events where organization_id = '${OUTRA_ORG}';`))),
    ).toBe(0);
  });

  it("A→B→C: o card termina em C, sozinho, e sem lead.assigned a mais", () => {
    atribui({ como: null, conversa: CONV.escada, para: B });
    expect(donoDoNegocio(NEG.escada)).toBe(B);

    atribui({ como: null, conversa: CONV.escada, para: C });
    expect(donoDoNegocio(NEG.escada)).toBe(C);
    expect(donoDaConversa(CONV.escada)).toBe(C);
    expect(quantosNegocios(CT.escada)).toBe(1);

    const eventos = eventosDeAtribuicao(NEG.escada);
    expect(eventos).toBe(2); // A→B e B→C

    // Repetir o dono atual não escreve no card: nenhum fato novo.
    atribui({ como: null, conversa: CONV.escada, para: C });
    expect(eventosDeAtribuicao(NEG.escada)).toBe(eventos);
    expect(donoDoNegocio(NEG.escada)).toBe(C);
  });

  it("a troca de carteira passa a conversa e NÃO leva o negócio que já tem dono (#2591)", () => {
    expect(donoDaConversa(CONV.carteira)).toBe(A);

    sql(`set role service_role;
      select public.fn_definir_carteira_do_cliente('${ORG}', null, '${CT.carteira}', '${C}', 'automacao');`);

    expect(donoDaConversa(CONV.carteira)).toBe(C);
    expect(donoDoNegocio(NEG.carteira)).toBe(A);
  });

  it("a passagem das conversas do contato NÃO leva o negócio que já tem dono", () => {
    const movidas = lastLine(
      sql(`set role service_role;
        select public.fn_passar_conversas_do_contato('${ORG}', '${CT.passagem}', '${C}');`),
    );

    expect(movidas).toBe("1");
    expect(donoDaConversa(CONV.passagem)).toBe(C);
    expect(donoDoNegocio(NEG.passagem)).toBe(B);
  });

  it("a passagem das conversas do contato preenche o único negócio aberto sem responsável", () => {
    expect(donoDoNegocio(NEG.passagemLivre)).toBe("SEM_DONO");

    sql(`set role service_role;
      select public.fn_passar_conversas_do_contato('${ORG}', '${CT.passagemLivre}', '${C}');`);

    expect(donoDaConversa(CONV.passagemLivre)).toBe(C);
    expect(donoDoNegocio(NEG.passagemLivre)).toBe(C);
  });

  it("caminho 4 (decisão de produto): com DOIS negócios abertos, nada é tocado", () => {
    atribui({ como: A, conversa: CONV.doisAbertos, para: B });

    expect(donoDaConversa(CONV.doisAbertos)).toBe(B);
    expect(donoDoNegocio(NEG.doisAbertosA)).toBe(A);
    expect(donoDoNegocio(NEG.doisAbertosB)).toBe("SEM_DONO");
  });
});
