/**
 * #4371 — A TROCA DE DONO DO CARD SÓ ACONTECE PELA TRANSFERÊNCIA, E OS DOIS
 * LADOS SÃO MEDIDOS NO MESMO ARQUIVO.
 *
 * ─── O que já está na main (medido antes de escrever este arquivo) ───────────
 *
 * O conserto FUNCIONAL do #4371 está na main desde a migration 9322 (PR #4382),
 * reafirmado pela 9361 (PR #4530): em `fn_conversation_assign`, a permissão do
 * negócio aceita o destino invisível quando `p_reason = 'transfer'` **e** o card
 * é de quem clicou (`v_negocio.owner_user_id = auth.uid()`). Na visibilidade
 * padrão, o `fn_can_view_lead(A → colega)` do destino responde "não vejo" e ei
 * que a escrita era pulada em silêncio — a conversa trocava de dono e o card
 * ficava com quem saiu.
 *
 * ─── O que este arquivo cerca, e por quê ────────────────────────────────────
 *
 * A outra metade do pedido do #4371 é o NEGATIVO: "a regra de visibilidade
 * continua valendo para os demais casos: um agente não toma nem entrega o card
 * de outra pessoa". Até aqui o negativo era provado só por TEXTO (o teste de
 * unidade confere o trecho do baseline) e por controles do caminho da definer.
 * Nada cobrava, no Postgres real e pela RLS, que um `agent` que dá `update`
 * direto em `crm_leads` — o caminho do PostgREST, que não passa pela
 * `fn_conversation_assign` — continue sendo recusado. Uma policy afrouxada
 * (`using (true)`, ou um termo novo para `authenticated`) passaria com a suíte
 * verde e o card voltaria a trocar de dono por fora da transferência.
 *
 * Por isso os DOIS lados moram juntos aqui:
 *
 *   POSITIVO — o `agent` dono do card transfere a conversa pelo caminho do
 *     produto (`fn_conversation_assign`, `p_reason = 'transfer'`) e o card vai
 *     junto; a colega passa a vê-lo (é o filtro "Responsável" dela).
 *   NEGATIVO — o mesmo `agent`, com `update` direto na tabela (o que o
 *     PostgREST faz numa chamada de `.update`), NÃO troca o dono: o banco recusa
 *     e o card fica onde está. Também é recusado tomando o card de um colega, e
 *     a exceção não vale para `'claim'` nem para quem não é o dono do card.
 *
 * A recusa do negativo tem DOIS degraus, medidos na sabotagem: o `WITH CHECK` de
 * `crm_leads_update` e a policy de SELECT, que o PostgreSQL reavalia na linha
 * NOVA do `update`. Abrir só a policy de escrita não libera a troca — com
 * `crm_leads_update` em `using (true) with check (true)`, trocar o TÍTULO passa
 * (1 linha) e trocar `owner_user_id` para uma colega continua respondendo
 * `42501 new row violates row-level security` —, e é por isso que a cerca do fim
 * fixa as duas policies, não só a de escrita.
 *
 * E a CERCA do conjunto de policies: o nome e a forma de cada policy de
 * `crm_leads` ficam fixados. Policy nova (ou permissiva) neste conjunto tem de
 * vir com este teste vermelho e uma decisão explícita — é a trava que o pedido
 * do #4371 cobra ("sem abrir a policy para qualquer escrita").
 *
 * Postgres real (`pnpm test:db`), JWT pelas claims — o mesmo caminho de
 * `auth.uid()` que a produção usa.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { lastLine, sql, writeCountAs } from "./gov-helpers";

const ORG = "eeeeeeee-0000-4000-8000-000000000001";
const A = "eeeeeeee-1111-4000-8000-000000000001"; // agent que transfere (dono do card)
const B = "eeeeeeee-1111-4000-8000-000000000002"; // agent que recebe
const C = "eeeeeeee-1111-4000-8000-000000000003"; // agent terceiro (não participa)
const GESTOR = "eeeeeeee-1111-4000-8000-000000000004"; // manager (controle do positivo)
const SESSAO = "eeeeeeee-2222-4000-8000-000000000001";
const PIPELINE = "eeeeeeee-5555-4000-8000-000000000001";
const ETAPA = "eeeeeeee-5555-4000-8000-000000000002";

/** Um contato por caso: nenhum caso contamina o outro. */
const CT = {
  positivo: "eeeeeeee-3333-4000-8000-000000000001",
  direto: "eeeeeeee-3333-4000-8000-000000000002",
  doColega: "eeeeeeee-3333-4000-8000-000000000003",
  claim: "eeeeeeee-3333-4000-8000-000000000004",
  naoDono: "eeeeeeee-3333-4000-8000-000000000005",
  gestor: "eeeeeeee-3333-4000-8000-000000000006",
} as const;

const CONV = {
  positivo: "eeeeeeee-4444-4000-8000-000000000001",
  direto: "eeeeeeee-4444-4000-8000-000000000002",
  doColega: "eeeeeeee-4444-4000-8000-000000000003",
  claim: "eeeeeeee-4444-4000-8000-000000000004",
  naoDono: "eeeeeeee-4444-4000-8000-000000000005",
  gestor: "eeeeeeee-4444-4000-8000-000000000006",
} as const;

const NEG = {
  positivo: "eeeeeeee-6666-4000-8000-000000000001",
  direto: "eeeeeeee-6666-4000-8000-000000000002",
  doColega: "eeeeeeee-6666-4000-8000-000000000003",
  claim: "eeeeeeee-6666-4000-8000-000000000004",
  naoDono: "eeeeeeee-6666-4000-8000-000000000005",
  gestor: "eeeeeeee-6666-4000-8000-000000000006",
} as const;

/** Os dois donos, literais (nunca inferidos do retorno da função). */
function donoDaConversa(conversa: string): string {
  return lastLine(
    sql(`select coalesce(assigned_to_user_id::text, 'SEM_DONO')
           from public.conversations where id = '${conversa}';`),
  );
}

function donoDoNegocio(negocio: string): string {
  return lastLine(
    sql(`select coalesce(owner_user_id::text, 'SEM_DONO') from public.crm_leads where id = '${negocio}';`),
  );
}

/** Quantos cards o usuário ENXERGA pela RLS — o filtro "Responsável" da tela. */
function quantosEnxerga(usuario: string, negocio: string): number {
  return Number(
    lastLine(
      sql(`set role authenticated;
        select set_config('request.jwt.claims', '{"sub":"${usuario}"}', false);
        select count(*) from public.crm_leads where id = '${negocio}';`),
    ),
  );
}

/** A chamada como as rotas fazem: sessão de pessoa, 6 argumentos (a assinatura de todo chamador). */
function atribui(p: { como: string; conversa: string; para: string; motivo?: string }): void {
  sql(`set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${p.como}"}', false);
    select public.fn_conversation_assign(
      '${ORG}', '${p.conversa}', '${p.para}', '${p.motivo ?? "transfer"}');`);
}

/** `update` direto na tabela, como o PostgREST faz — a porta que a policy fecha. */
function trocaDonoDireto(p: { como: string; negocio: string; para: string }): number {
  return writeCountAs(
    p.como,
    `update public.crm_leads set owner_user_id = '${p.para}', owner_agent_id = null,
            owner_kind = 'user', assigned_at = now()
      where id = '${p.negocio}'`,
  );
}

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${A}', 'card-pela-transferencia-a@invariant.test'),
      ('${B}', 'card-pela-transferencia-b@invariant.test'),
      ('${C}', 'card-pela-transferencia-c@invariant.test'),
      ('${GESTOR}', 'card-pela-transferencia-gestor@invariant.test')
    on conflict (id) do nothing;

    insert into public.organizations (id, slug, legal_name, display_name, settings) values
      ('${ORG}', 'card-pela-transferencia', 'Card Pela Transferencia', 'Card Pela Transferencia',
       '{"visibility_mode":"own_and_unassigned"}'::jsonb)
    on conflict (id) do nothing;

    update public.organizations
       set settings = coalesce(settings, '{}'::jsonb) || '{"visibility_mode":"own_and_unassigned"}'::jsonb
     where id = '${ORG}';

    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${A}', '${ORG}', 'agent', now()),
      ('${B}', '${ORG}', 'agent', now()),
      ('${C}', '${ORG}', 'agent', now()),
      ('${GESTOR}', '${ORG}', 'manager', now())
    on conflict (user_id, organization_id) do update
      set role = excluded.role, revoked_at = null, accepted_at = now();

    do $org$ begin
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
        values ('${SESSAO}', '${ORG}', 'card-pela-transferencia', '\\x00'::bytea);
    exception when unique_violation then null; end $org$;

    insert into public.crm_pipelines (id, organization_id, name, slug) values
      ('${PIPELINE}', '${ORG}', 'Card Pela Transferencia', 'card-pela-transferencia')
    on conflict (id) do nothing;

    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position) values
      ('${ETAPA}', '${ORG}', '${PIPELINE}', 'Novo', 'novo-card-pela-transferencia', 1000)
    on conflict (id) do nothing;

    insert into public.contacts (id, organization_id, display_name) values
      ('${CT.positivo}', '${ORG}', 'Contato Positivo'),
      ('${CT.direto}', '${ORG}', 'Contato Direto'),
      ('${CT.doColega}', '${ORG}', 'Contato Do Colega'),
      ('${CT.claim}', '${ORG}', 'Contato Claim'),
      ('${CT.naoDono}', '${ORG}', 'Contato Nao Dono'),
      ('${CT.gestor}', '${ORG}', 'Contato Gestor')
    on conflict (id) do nothing;
  `);

  const conversa = (id: string, contato: string, dono: string | null) =>
    sql(`insert into public.conversations
          (id, organization_id, contact_id, channel_session_id, status, assigned_to_user_id, assigned_at)
         values ('${id}', '${ORG}', '${contato}', '${SESSAO}', '${dono ? "claimed" : "open"}',
                 ${dono ? `'${dono}'` : "null"}, ${dono ? "now()" : "null"});`);

  const negocio = (id: string, contato: string, dono: string) =>
    sql(`insert into public.crm_leads
          (id, organization_id, pipeline_id, stage_id, title, contact_id, status, owner_user_id, owner_kind)
         values ('${id}', '${ORG}', '${PIPELINE}', '${ETAPA}', 'Card do caso', '${contato}', 'open',
                 '${dono}', 'user');`);

  // POSITIVO: card e conversa são do A.
  conversa(CONV.positivo, CT.positivo, A);
  negocio(NEG.positivo, CT.positivo, A);

  // NEGATIVO 1: card e conversa do A — o update direto tentará entregar a B.
  conversa(CONV.direto, CT.direto, A);
  negocio(NEG.direto, CT.direto, A);

  // NEGATIVO 2: o card é do B; o A tenta tomá-lo por update direto.
  conversa(CONV.doColega, CT.doColega, A);
  negocio(NEG.doColega, CT.doColega, B);

  // NEGATIVO 3: 'claim' não é 'transfer' — a conversa está SEM dono (Assumir
  // só alcança conversa livre), e o card do A fica onde está.
  conversa(CONV.claim, CT.claim, null);
  negocio(NEG.claim, CT.claim, A);

  // NEGATIVO 4: o card é do C e a conversa é do A — quem transfere não é dono do card.
  conversa(CONV.naoDono, CT.naoDono, A);
  negocio(NEG.naoDono, CT.naoDono, C);

  // CONTROLE: gestor entrega o card do A (o positivo não é exclusividade do dono).
  conversa(CONV.gestor, CT.gestor, A);
  negocio(NEG.gestor, CT.gestor, A);
});

afterAll(() => {
  sql(`
    delete from public.event_log where organization_id = '${ORG}';
    delete from public.conversation_assignment_events where organization_id = '${ORG}';
    delete from public.conversations where organization_id = '${ORG}';
    delete from public.crm_leads where organization_id = '${ORG}';
    delete from public.contacts where organization_id = '${ORG}';
    delete from public.crm_stages where organization_id = '${ORG}';
    delete from public.crm_pipelines where organization_id = '${ORG}';
    delete from public.channel_sessions where organization_id = '${ORG}';
    delete from public.user_organizations where organization_id = '${ORG}';
    delete from public.organizations where id = '${ORG}';
    delete from auth.users where id in ('${A}', '${B}', '${C}', '${GESTOR}');
  `);
});

describe("#4371 — o card só troca de dono pela transferência", () => {
  it("POSITIVO: agent dono do card transfere e o card vai junto; a colega passa a vê-lo", () => {
    expect(donoDaConversa(CONV.positivo)).toBe(A);
    expect(donoDoNegocio(NEG.positivo)).toBe(A);
    // Na visibilidade padrão, o A não enxerga a carteira da B: é esta conta que
    // fazia a escrita ser pulada.
    expect(quantosEnxerga(A, NEG.positivo)).toBe(1);
    expect(quantosEnxerga(C, NEG.positivo)).toBe(0);

    atribui({ como: A, conversa: CONV.positivo, para: B });

    expect(donoDaConversa(CONV.positivo)).toBe(B);
    expect(donoDoNegocio(NEG.positivo)).toBe(B);
    // O que a colega vê no filtro "Responsável" depois de receber o atendimento.
    expect(quantosEnxerga(B, NEG.positivo)).toBe(1);
    expect(quantosEnxerga(A, NEG.positivo)).toBe(0);
  });

  it("CONTROLE: o gestor entrega o card de um colega — o positivo não depende de ser o dono", () => {
    expect(donoDoNegocio(NEG.gestor)).toBe(A);

    atribui({ como: GESTOR, conversa: CONV.gestor, para: B });

    expect(donoDaConversa(CONV.gestor)).toBe(B);
    expect(donoDoNegocio(NEG.gestor)).toBe(B);
  });

  it("NEGATIVO: o agent dono troca o dono do card DIRETO (PostgREST) e o banco recusa", () => {
    expect(donoDoNegocio(NEG.direto)).toBe(A);

    const linhas = trocaDonoDireto({ como: A, negocio: NEG.direto, para: B });

    // `WITH CHECK` de `crm_leads_update`: o novo responsável (B) não é visível
    // ao A em `own_and_unassigned` — a escrita é recusada, não "pulada".
    expect(linhas).toBe(0);
    expect(donoDoNegocio(NEG.direto)).toBe(A);
  });

  it("NEGATIVO: o agent não toma o card de um colega por update direto", () => {
    expect(donoDoNegocio(NEG.doColega)).toBe(B);
    expect(quantosEnxerga(A, NEG.doColega)).toBe(0);

    const linhas = trocaDonoDireto({ como: A, negocio: NEG.doColega, para: A });

    expect(linhas).toBe(0);
    expect(donoDoNegocio(NEG.doColega)).toBe(B);
  });

  it("NEGATIVO: 'claim' não leva o card que já tem dono (a exceção exige 'transfer')", () => {
    expect(donoDaConversa(CONV.claim)).toBe("SEM_DONO");
    expect(donoDoNegocio(NEG.claim)).toBe(A);

    atribui({ como: B, conversa: CONV.claim, para: B, motivo: "claim" });

    expect(donoDaConversa(CONV.claim)).toBe(B);
    expect(donoDoNegocio(NEG.claim)).toBe(A);
  });

  it("NEGATIVO: quem transfere SEM ser dono do card não o leva", () => {
    expect(donoDoNegocio(NEG.naoDono)).toBe(C);

    atribui({ como: A, conversa: CONV.naoDono, para: B });

    expect(donoDaConversa(CONV.naoDono)).toBe(B);
    expect(donoDoNegocio(NEG.naoDono)).toBe(C);
  });

  it("CERCA: o conjunto de policies de crm_leads não ganhou termo permissivo", () => {
    // Nome + comando de cada policy da tabela. Policy nova entra aqui de
    // propósito, com decisão — nunca por acidente.
    expect(
      sql(`select cmd || ':' || policyname from pg_policies
            where schemaname = 'public' and tablename = 'crm_leads' order by cmd, policyname;`),
    ).toBe(
      [
        "DELETE:crm_leads_delete",
        "DELETE:support_write_delete",
        "INSERT:crm_leads_insert",
        "INSERT:support_write_insert",
        "SELECT:crm_leads_select",
        "UPDATE:crm_leads_update",
        "UPDATE:support_write_update",
      ].join("\n"),
    );

    // E nenhuma delas libera por `true`: a escrita continua passando por
    // organização + papel + visibilidade do negócio (ou pelo apoio somente
    // leitura, que tem porta própria).
    const permissivas = sql(`select policyname || ' | ' || coalesce(qual, '-') || ' | ' || coalesce(with_check, '-')
                               from pg_policies
                              where schemaname = 'public' and tablename = 'crm_leads';`)
      .split("\n")
      .filter((linha) => /\|\s*true\s*\||\|\s*true$/.test(linha));
    expect(permissivas).toEqual([]);

    const deUpdate = sql(`select coalesce(qual, '-') || ' | ' || coalesce(with_check, '-')
                            from pg_policies
                           where schemaname = 'public' and tablename = 'crm_leads'
                             and policyname = 'crm_leads_update';`);
    // A régua de escrita do negócio, termo por termo: organização do chamador,
    // papel agent+ e (manager+ OU o negócio visível). É ela que o negativo acima
    // exercita; sem `fn_can_view_lead` o teste de cima ficaria vermelho.
    expect(deUpdate).toContain("fn_user_org_ids()");
    expect(deUpdate).toContain("fn_role_at_least(organization_id, 'agent'::text)");
    expect(deUpdate).toContain("fn_can_view_lead(organization_id, owner_user_id)");
  });
});
