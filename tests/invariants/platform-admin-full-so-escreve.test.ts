/**
 * 0508 — platform admin `support_readonly` não escreve pelo PostgREST (#2000).
 *
 * A policy `orgs_write_platform_admin` usava `fn_is_platform_admin()`, que ignora
 * o scope do JWT (~:325-333). Um platform admin com `scope = 'support_readonly'`
 * alterava colunas de exibição e `settings` de organizations com o próprio JWT.
 *
 * O conserto troca as policies de ESCRITA para `fn_is_platform_admin_full()`
 * (idêntica à atual, mas exigindo `scope = 'full'`), mantendo a leitura
 * (FOR SELECT) com `fn_is_platform_admin()` — `support_readonly` segue lendo,
 * só não escreve.
 *
 * Invariante medido em Postgres REAL:
 *   · JWT `support_readonly` → 0 linhas alteradas em organizations;
 *   · JWT `full` → continua escrevendo (controle positivo);
 *   · `support_readonly` continua LENDO a organização (a leitura não foi tocada).
 *
 * Previsão escrita antes de rodar (sabotagem): se o fix for revertido e as
 * policies voltarem a usar `fn_is_platform_admin()`, o caso "support_readonly"
 * devolve 1 em vez de 0 (o bug reabre) — os casos "0" ficam vermelhos.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { countAs, seedGov, sql, writeCountAs } from "./gov-helpers";

const ORG = "cccccccc-2000-4000-8000-000000000001";
/** Platform admin `full` — o controle positivo que CONTINUA escrevendo. */
const FULL = "cccccccc-2000-4000-8000-000000000100";
/** Platform admin `support_readonly` — o caso que deve ficar em 0. */
const READONLY = "cccccccc-2000-4000-8000-000000000101";

beforeAll(() => {
  seedGov();
  sql(`
    delete from public.organizations where id = '${ORG}';
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG}', 'org-0508', 'Org 0508', 'Org 0508');
    insert into auth.users (id, email) values
      ('${FULL}', 'full-0508@invariant.test'),
      ('${READONLY}', 'readonly-0508@invariant.test')
    on conflict (id) do nothing;
    delete from public.platform_admins where user_id in ('${FULL}', '${READONLY}');
    insert into public.platform_admins (user_id, granted_by, scope, mfa_required, reason) values
      ('${FULL}', '${FULL}', 'full', false, 'invariante 0508'),
      ('${READONLY}', '${FULL}', 'support_readonly', false, 'invariante 0508');
  `);
});

describe("0508 — support_readonly não escreve em organizations pelo PostgREST", () => {
  it("support_readonly altera 0 linhas de display_name", () => {
    expect(
      writeCountAs(
        READONLY,
        `update public.organizations set display_name = 'hackeado-readonly' where id = '${ORG}'`,
      ),
    ).toBe(0);
  });

  it("support_readonly altera 0 linhas de settings", () => {
    expect(
      writeCountAs(
        READONLY,
        `update public.organizations set settings = '{"data": "hackeado"}'::jsonb where id = '${ORG}'`,
      ),
    ).toBe(0);
  });

  it("CONTROLE POSITIVO: o platform admin full continua escrevendo display_name", () => {
    expect(
      writeCountAs(
        FULL,
        `update public.organizations set display_name = 'escrito-pelo-full' where id = '${ORG}'`,
      ),
    ).toBe(1);
  });

  it("CONTROLE POSITIVO: o platform admin full continua escrevendo settings", () => {
    expect(
      writeCountAs(
        FULL,
        `update public.organizations set settings = '{"data": "escrito pelo full"}'::jsonb where id = '${ORG}'`,
      ),
    ).toBe(1);
  });

  it("support_readonly continua LENDO a organização (a leitura não foi tocada)", () => {
    expect(countAs(READONLY, `select count(*) from public.organizations where id = '${ORG}';`)).toBe(1);
  });

  it("CONTROLE POSITIVO: o full também lê a organização", () => {
    expect(countAs(FULL, `select count(*) from public.organizations where id = '${ORG}';`)).toBe(1);
  });
});

/* ======================================================================== *
 * 0529 — fatia 1 da #2115: as policies de ESCRITA criadas nos APÊNDICES.
 *
 * A 0508 consertou o trecho do DUMP; as policies deste recorte ficaram com
 * `fn_is_platform_admin()`, que ignora o scope do JWT. Medição refeita na
 * `main@47c03e678` (última definição por tabela.nome): 47 policies de escrita
 * com a função pura, exatamente a lista do issue.
 *
 * O invariante mede em Postgres REAL, nas duas direções:
 *   · CATÁLOGO: as 11 expressões vivas em `pg_policies` usam `_full` e não a
 *     pura — é o que o banco tem, não o texto do arquivo;
 *   · COMPORTAMENTO: como `support_readonly`, 0 linhas em cada escrita; como
 *     `full`, as mesmas escritas passam (controle positivo);
 *   · LEITURA: `support_readonly` segue LENDO (`team_invites`, `messages` e
 *     `channel_sessions`), que é o que a troca não podia derrubar (#2078).
 *
 * Previsão escrita antes de rodar (sabotagem): revertidas as 11 policies para
 * `fn_is_platform_admin()`, o caso de catálogo acusa as 11 e todo caso "0"
 * devolve 1 — vermelho. A leitura continua verde: a sabotagem não a toca.
 * ======================================================================== */

const ORG_0529 = "cccccccc-2115-4000-8000-000000000001";
const FULL_0529 = "cccccccc-2115-4000-8000-000000000100";
const READONLY_0529 = "cccccccc-2115-4000-8000-000000000101";
const CONTACT_0529 = "cccccccc-2115-4000-8000-000000000002";
const SESSION_0529 = "cccccccc-2115-4000-8000-000000000003";
const CONV_0529 = "cccccccc-2115-4000-8000-000000000004";
const MSG_0529 = "cccccccc-2115-4000-8000-000000000005";
const MSG_PROBE_0529 = "cccccccc-2115-4000-8000-000000000006";
const PIPELINE_0529 = "cccccccc-2115-4000-8000-000000000007";
const STAGE_0529 = "cccccccc-2115-4000-8000-000000000008";
const LEAD_0529 = "cccccccc-2115-4000-8000-000000000009";
const INVITE_0529 = "cccccccc-2115-4000-8000-00000000000a";
const CONTACT_PROBE_0529 = "cccccccc-2115-4000-8000-00000000000b";

/** As 11 policies da fatia — `[tabela, policy]`, na ordem do issue. */
const FATIA_1: ReadonlyArray<readonly [string, string]> = [
  ["team_invites", "team_invites_write"],
  ["messages", "messages_insert"],
  ["messages", "messages_update"],
  ["messages", "messages_delete"],
  ["crm_leads", "crm_leads_insert"],
  ["crm_leads", "crm_leads_update"],
  ["crm_leads", "crm_leads_delete"],
  ["channel_sessions", "channel_sessions_tenant_write"],
  ["conversations", "conversations_agent_insert"],
  ["conversations", "conversations_agent_update"],
  ["conversations", "conversations_agent_delete"],
];

/** USING/WITH CHECK vivos da policy, direto de `pg_policies`. */
function expressaoViva(tabela: string, policy: string): string {
  const out = sql(`
    select coalesce(qual, '(sem using)') || ' :: ' || coalesce(with_check, '(sem with check)')
      from pg_policies
     where schemaname = 'public' and tablename = '${tabela}' and policyname = '${policy}';
  `);
  if (!out) throw new Error(`policy ${policy} não existe em public.${tabela}`);
  return out;
}

describe("0529 — support_readonly não escreve na fatia 1 do #2115", () => {
  beforeAll(() => {
    sql(`
      -- Filhos antes do pai: conversations→channel_sessions é ON DELETE RESTRICT.
      delete from public.messages where organization_id = '${ORG_0529}';
      delete from public.conversations where organization_id = '${ORG_0529}';
      delete from public.channel_sessions where organization_id = '${ORG_0529}';
      delete from public.organizations where id = '${ORG_0529}';
      insert into public.organizations (id, slug, legal_name, display_name)
        values ('${ORG_0529}', 'org-2115', 'Org 2115', 'Org 2115');
      insert into auth.users (id, email) values
        ('${FULL_0529}', 'full-2115@invariant.test'),
        ('${READONLY_0529}', 'readonly-2115@invariant.test')
      on conflict (id) do nothing;
      delete from public.platform_admins where user_id in ('${FULL_0529}', '${READONLY_0529}');
      insert into public.platform_admins (user_id, granted_by, scope, mfa_required, reason) values
        ('${FULL_0529}', '${FULL_0529}', 'full', false, 'invariante 2115'),
        ('${READONLY_0529}', '${FULL_0529}', 'support_readonly', false, 'invariante 2115');
      insert into public.contacts (id, organization_id, display_name)
        values ('${CONTACT_0529}', '${ORG_0529}', 'Contato 2115'),
               ('${CONTACT_PROBE_0529}', '${ORG_0529}', 'Contato sonda 2115');
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
        values ('${SESSION_0529}', '${ORG_0529}', 'inv-2115', '\\x00'::bytea);
      insert into public.conversations (id, organization_id, contact_id, channel_session_id, status)
        values ('${CONV_0529}', '${ORG_0529}', '${CONTACT_0529}', '${SESSION_0529}', 'open');
      insert into public.messages (id, organization_id, conversation_id, channel_session_id, contact_id, type, direction, body)
        values ('${MSG_0529}', '${ORG_0529}', '${CONV_0529}', '${SESSION_0529}', '${CONTACT_0529}', 'text', 'inbound', 'corpo 2115'),
               ('${MSG_PROBE_0529}', '${ORG_0529}', '${CONV_0529}', '${SESSION_0529}', '${CONTACT_0529}', 'text', 'inbound', 'sonda 2115');
      insert into public.crm_pipelines (id, organization_id, name, slug)
        values ('${PIPELINE_0529}', '${ORG_0529}', 'Funil 2115', 'funil-2115');
      insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position)
        values ('${STAGE_0529}', '${ORG_0529}', '${PIPELINE_0529}', 'Novo', 'novo', 1000);
      insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title)
        values ('${LEAD_0529}', '${ORG_0529}', '${PIPELINE_0529}', '${STAGE_0529}', 'Lead 2115');
      insert into public.team_invites (id, organization_id, email, role, expires_at)
        values ('${INVITE_0529}', '${ORG_0529}', 'convidado-2115@invariant.test', 'agent', now() + interval '7 days');
    `);
  });

  it("catálogo: as 11 policies vivas usam fn_is_platform_admin_full() e não a pura", () => {
    const faltando: string[] = [];
    for (const [tabela, policy] of FATIA_1) {
      const expr = expressaoViva(tabela, policy);
      // `_full` não casa com `fn_is_platform_admin\s*\(` — o que sobra de puro é furo.
      if (!expr.includes("fn_is_platform_admin_full")) faltando.push(`${tabela}.${policy}: sem _full`);
      if (/fn_is_platform_admin\s*\(/.test(expr)) faltando.push(`${tabela}.${policy}: ainda aceita a pura`);
    }
    expect(faltando, "policy de escrita da fatia 1 fora do conserto da 0508/0529").toEqual([]);
  });

  it("support_readonly continua LENDO team_invites, messages e channel_sessions", () => {
    // A troca é nas policies de ESCRITA; a leitura tem policy SELECT própria e
    // não foi tocada. Sem esta guarda, um conserto que reescrevesse a escrita
    // sobre a única policy de leitura derrubaria o modo de observação.
    expect(countAs(READONLY_0529, `select count(*) from public.team_invites where id = '${INVITE_0529}';`)).toBe(1);
    expect(countAs(READONLY_0529, `select count(*) from public.messages where id = '${MSG_0529}';`)).toBe(1);
    expect(countAs(READONLY_0529, `select count(*) from public.channel_sessions where id = '${SESSION_0529}';`)).toBe(1);
  });

  it("team_invites: UPDATE 0 como support_readonly; 1 como full", () => {
    expect(writeCountAs(READONLY_0529, `update public.team_invites set inviter_name = 'hackeado' where id = '${INVITE_0529}'`)).toBe(0);
    expect(writeCountAs(FULL_0529, `update public.team_invites set inviter_name = 'escrito pelo full' where id = '${INVITE_0529}'`)).toBe(1);
  });

  it("messages: UPDATE 0 como support_readonly; 1 como full", () => {
    expect(writeCountAs(READONLY_0529, `update public.messages set body = 'hackeado' where id = '${MSG_0529}'`)).toBe(0);
    expect(writeCountAs(FULL_0529, `update public.messages set body = 'escrito pelo full' where id = '${MSG_0529}'`)).toBe(1);
  });

  it("messages: DELETE 0 como support_readonly; a sonda some como full", () => {
    expect(writeCountAs(READONLY_0529, `delete from public.messages where id = '${MSG_PROBE_0529}'`)).toBe(0);
    expect(writeCountAs(FULL_0529, `delete from public.messages where id = '${MSG_PROBE_0529}'`)).toBe(1);
  });

  it("messages: INSERT negado por RLS como support_readonly; o full passa da RLS e para na trigger", () => {
    // Inbound é reservado (`message.received`) e o full não é membro da org: o
    // insert dele nunca completa. O que se prova é que ele PASSA da RLS
    // (WITH CHECK) e para na trigger AFTER INSERT `trg_messages_emit_event`.
    const linha = (id: string, body: string) =>
      `insert into public.messages (id, organization_id, conversation_id, channel_session_id, contact_id, type, direction, body) values ('${id}', '${ORG_0529}', '${CONV_0529}', '${SESSION_0529}', '${CONTACT_0529}', 'text', 'inbound', '${body}')`;
    expect(writeCountAs(READONLY_0529, linha("cccccccc-2115-4000-8000-0000000000c1", "sonda readonly"))).toBe(0);
    let erroDoFull = "";
    try {
      writeCountAs(FULL_0529, linha("cccccccc-2115-4000-8000-0000000000c2", "sonda full"));
    } catch (err) {
      erroDoFull = (err as { stderr?: string }).stderr ?? String(err);
    }
    // Negado por RLS, `writeCountAs` devolveria 0 sem lançar: `erroDoFull` vazio, vermelho.
    expect(erroDoFull).toMatch(/reserved_message_received/);
  });

  it("conversations: UPDATE 0 como support_readonly; 1 como full", () => {
    expect(writeCountAs(READONLY_0529, `update public.conversations set tags = array['hackeado'] where id = '${CONV_0529}'`)).toBe(0);
    expect(writeCountAs(FULL_0529, `update public.conversations set tags = array['escrito'] where id = '${CONV_0529}'`)).toBe(1);
  });

  it("conversations: INSERT 0 como support_readonly; 1 como full", () => {
    // `claimed` com responsável evita o gatilho de roteamento (que só dispara
    // para conversa aberta E sem responsável) — o alvo aqui é a policy.
    const linha = (id: string) =>
      `insert into public.conversations (id, organization_id, contact_id, channel_session_id, status, assigned_to_user_id, assigned_at) values ('${id}', '${ORG_0529}', '${CONTACT_PROBE_0529}', '${SESSION_0529}', 'claimed', '${FULL_0529}', now())`;
    expect(writeCountAs(READONLY_0529, linha("cccccccc-2115-4000-8000-0000000000d1"))).toBe(0);
    expect(writeCountAs(FULL_0529, linha("cccccccc-2115-4000-8000-0000000000d2"))).toBe(1);
  });

  it("crm_leads: UPDATE 0 como support_readonly; 1 como full", () => {
    expect(writeCountAs(READONLY_0529, `update public.crm_leads set title = 'hackeado' where id = '${LEAD_0529}'`)).toBe(0);
    expect(writeCountAs(FULL_0529, `update public.crm_leads set title = 'escrito pelo full' where id = '${LEAD_0529}'`)).toBe(1);
  });

  it("crm_leads: INSERT 0 como support_readonly; 1 como full", () => {
    const linha = (id: string) =>
      `insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title) values ('${id}', '${ORG_0529}', '${PIPELINE_0529}', '${STAGE_0529}', 'Lead sonda')`;
    expect(writeCountAs(READONLY_0529, linha("cccccccc-2115-4000-8000-0000000000e1"))).toBe(0);
    expect(writeCountAs(FULL_0529, linha("cccccccc-2115-4000-8000-0000000000e2"))).toBe(1);
  });

  it("channel_sessions: UPDATE 0 como support_readonly; 1 como full", () => {
    expect(writeCountAs(READONLY_0529, `update public.channel_sessions set metadata = '{"sonda": "readonly"}'::jsonb where id = '${SESSION_0529}'`)).toBe(0);
    expect(writeCountAs(FULL_0529, `update public.channel_sessions set metadata = '{"sonda": "full"}'::jsonb where id = '${SESSION_0529}'`)).toBe(1);
  });

  it("channel_sessions: INSERT 0 como support_readonly; 1 como full", () => {
    const linha = (id: string, nome: string) =>
      `insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted) values ('${id}', '${ORG_0529}', '${nome}', '\\x00'::bytea)`;
    expect(writeCountAs(READONLY_0529, linha("cccccccc-2115-4000-8000-0000000000f1", "sonda-readonly-2115"))).toBe(0);
    expect(writeCountAs(FULL_0529, linha("cccccccc-2115-4000-8000-0000000000f2", "sonda-full-2115"))).toBe(1);
  });
});

/* ======================================================================== *
 * 0533 — fatia 2 da #2115: as 36 restantes (prioridade 5).
 *
 * Medição na main@17c4b81b8 (pós-#2193): 36 policies de escrita com a função
 * pura — 29 trocas diretas de topo, 6 policies internas do módulo honorários
 * (o corpo de `fn_honorarios_provisionar` é redefinido; as duas SELECT dele
 * seguem com a função pura) e o único par da lista, em `recurring_entries`
 * (a única das 47 sem SELECT própria).
 *
 * COBERTURA: o catálogo mede as 36 expressões vivas (`pg_policies`), o par é
 * medido em COMPORTAMENTO — leitura de pé, `support_readonly` com 0 linhas,
 * `full` escrevendo — e a última asserção é a conta GLOBAL: nenhuma policy de
 * escrita em `public` volta a citar a função pura, nem por definição nova, nem
 * pelo caminho dinâmico (os laços `format()` de 0350/0351 usavam a pura; ver
 * `platform-admin-full-so-escreve-dinamicas.test.ts`).
 *
 * As 35 trocas diretas não ganham sonda tabela a tabela: o mecanismo é o mesmo
 * que a fatia 1 mede em cinco delas, e o catálogo é o que prova a expressão de
 * cada uma.
 *
 * Previsão escrita antes de rodar (sabotagem): de volta à função pura, o
 * catálogo acusa as 36, a conta global acusa as mesmas e o comportamento do par
 * devolve 1/0 — vermelho.
 * ======================================================================== */

const ORG_0533 = "cccccccc-2115-4000-8000-000000000201";
const FULL_0533 = "cccccccc-2115-4000-8000-000000000210";
const READONLY_0533 = "cccccccc-2115-4000-8000-000000000211";
const CONTA_0533 = "cccccccc-2115-4000-8000-000000000202";
const RECORRENTE_0533 = "cccccccc-2115-4000-8000-000000000203";
const RECORRENTE_PROBE_0533 = "cccccccc-2115-4000-8000-000000000204";

/** As 36 policies de ESCRITA da fatia 2 — `[tabela, policy]`. */
const FATIA_2: ReadonlyArray<readonly [string, string]> = [
  ["ai_agents", "tenant_isolation_ai_agents_write"],
  ["ai_budgets", "tenant_isolation_ai_budgets_write"],
  ["ai_chunks", "tenant_isolation_ai_chunks_write"],
  ["ai_knowledge_sources", "tenant_isolation_ai_knowledge_sources_write"],
  ["ai_knowledge_versions", "tenant_isolation_ai_kbv_write"],
  ["attendant_availability", "attendant_availability_delete"],
  ["attendant_availability", "attendant_availability_insert"],
  ["attendant_availability", "attendant_availability_update"],
  ["automation_rules", "automation_rules_manager_write"],
  ["calendar_appointments", "calendar_appointments_write"],
  ["calendar_availability_exceptions", "calendar_availability_exceptions_write"],
  ["calendar_event_types", "calendar_event_types_write"],
  ["calendar_locations", "calendar_locations_insert"],
  ["campaign_channel_sessions", "campaign_channel_sessions_write"],
  ["campaign_recipients", "campaign_recipients_write"],
  ["campaign_suppressions", "campaign_suppressions_write"],
  ["campaign_templates", "campaign_templates_write"],
  ["campaigns", "campaigns_write"],
  ["catalog_products", "catalog_products_write"],
  ["crm_lead_activities", "crm_lead_activities_insert"],
  ["crm_lead_links", "crm_lead_links_delete"],
  ["crm_lead_links", "crm_lead_links_insert"],
  ["crm_lead_links", "crm_lead_links_update"],
  ["crm_pipelines", "crm_pipelines_manager_write"],
  ["crm_stages", "crm_stages_manager_write"],
  ["crm_tasks", "crm_tasks_write"],
  ["honorarios_contratos", "honorarios_contratos_delete"],
  ["honorarios_contratos", "honorarios_contratos_insert"],
  ["honorarios_contratos", "honorarios_contratos_update"],
  ["honorarios_parcelas", "honorarios_parcelas_delete"],
  ["honorarios_parcelas", "honorarios_parcelas_insert"],
  ["honorarios_parcelas", "honorarios_parcelas_update"],
  ["org_guardrail_layers", "org_guardrail_layers_admin_write"],
  ["org_voice_calls", "org_voice_calls_admin_write"],
  ["recurring_entries", "tenant_isolation_recurring_entries_write"],
  ["webhook_sources", "webhook_sources_manager_write"],
];

describe("0533 — support_readonly não escreve na fatia 2 do #2115 (prioridade 5)", () => {
  beforeAll(() => {
    sql(`
      -- O módulo honorários não põe tabela no baseline: as 6 policies internas
      -- dele nascem no provisionamento. Instalar aqui é o que as põe no catálogo
      -- e na conta global (mesmo chamado que honorarios-rls-por-operacao usa).
      select public.fn_honorarios_provisionar();

      -- Filhos antes do pai: financial_accounts -> recurring_entries é RESTRICT.
      delete from public.recurring_entries where organization_id = '${ORG_0533}';
      delete from public.financial_accounts where organization_id = '${ORG_0533}';
      delete from public.organizations where id = '${ORG_0533}';
      insert into public.organizations (id, slug, legal_name, display_name)
        values ('${ORG_0533}', 'org-2115-2', 'Org 2115-2', 'Org 2115-2');
      insert into auth.users (id, email) values
        ('${FULL_0533}', 'full-2115-2@invariant.test'),
        ('${READONLY_0533}', 'readonly-2115-2@invariant.test')
      on conflict (id) do nothing;
      delete from public.platform_admins where user_id in ('${FULL_0533}', '${READONLY_0533}');
      insert into public.platform_admins (user_id, granted_by, scope, mfa_required, reason) values
        ('${FULL_0533}', '${FULL_0533}', 'full', false, 'invariante 2115 fatia 2'),
        ('${READONLY_0533}', '${FULL_0533}', 'support_readonly', false, 'invariante 2115 fatia 2');
      insert into public.financial_accounts (id, organization_id, name)
        values ('${CONTA_0533}', '${ORG_0533}', 'Conta 2115-2');
      insert into public.recurring_entries (id, organization_id, name, account_id, direction, amount_cents, day_of_month)
        values ('${RECORRENTE_0533}', '${ORG_0533}', 'Aluguel 2115-2', '${CONTA_0533}', 'out', 100000, 5),
               ('${RECORRENTE_PROBE_0533}', '${ORG_0533}', 'Sonda 2115-2', '${CONTA_0533}', 'out', 200000, 10);
    `);
  });

  it("catálogo: as 36 policies de escrita vivas usam _full e não a pura", () => {
    const faltando: string[] = [];
    for (const [tabela, policy] of FATIA_2) {
      const expr = expressaoViva(tabela, policy);
      if (!expr.includes("fn_is_platform_admin_full")) faltando.push(`${tabela}.${policy}: sem _full`);
      if (/fn_is_platform_admin\s*\(/.test(expr)) faltando.push(`${tabela}.${policy}: ainda aceita a pura`);
    }
    expect(faltando, "policy de escrita da fatia 2 fora do conserto da 0533").toEqual([]);
  });

  it("catálogo: a leitura de recurring_entries MANTÉM a função pura — o par não restringe leitura", () => {
    const expr = expressaoViva("recurring_entries", "tenant_isolation_recurring_entries_read");
    expect(expr).toContain("fn_is_platform_admin");
    expect(expr).not.toContain("fn_is_platform_admin_full");
  });

  it("recurring_entries: a política _all não existe mais (virou par)", () => {
    expect(
      sql(
        `select count(*) from pg_policies where schemaname = 'public' and tablename = 'recurring_entries' and policyname = 'tenant_isolation_recurring_entries_all';`,
      ),
    ).toBe("0");
  });

  it("CONTA GLOBAL: nenhuma policy de escrita em public cita a função pura", () => {
    // Fecha a superfície inteira da #2115: as 47 do texto + qualquer definição
    // nova. As dinâmicas do baseline (`tenant_isolation_%s_all` e
    // `support_write_*`) não usam a função pura; se uma futura passar a usar,
    // este caso fica vermelho antes de o defeito chegar a um clone.
    const n = sql(`
      select count(*) from pg_policies
       where schemaname = 'public'
         and cmd <> 'SELECT'
         and (qual like '%fn_is_platform_admin(%' or with_check like '%fn_is_platform_admin(%');
    `);
    expect(Number(n), "ainda há policy de escrita aceitando a função pura").toBe(0);
  });

  it("recurring_entries: support_readonly segue LENDO o molde", () => {
    expect(countAs(READONLY_0533, `select count(*) from public.recurring_entries where id = '${RECORRENTE_0533}';`)).toBe(1);
  });

  it("recurring_entries: UPDATE 0 como support_readonly; 1 como full", () => {
    expect(writeCountAs(READONLY_0533, `update public.recurring_entries set name = 'hackeado' where id = '${RECORRENTE_0533}'`)).toBe(0);
    expect(writeCountAs(FULL_0533, `update public.recurring_entries set name = 'escrito pelo full' where id = '${RECORRENTE_0533}'`)).toBe(1);
  });

  it("recurring_entries: INSERT 0 como support_readonly; 1 como full", () => {
    const linha = (id: string, nome: string) =>
      `insert into public.recurring_entries (id, organization_id, name, account_id, direction, amount_cents, day_of_month) values ('${id}', '${ORG_0533}', '${nome}', '${CONTA_0533}', 'in', 5000, 15)`;
    expect(writeCountAs(READONLY_0533, linha("cccccccc-2115-4000-8000-0000000002c1", "sonda readonly"))).toBe(0);
    expect(writeCountAs(FULL_0533, linha("cccccccc-2115-4000-8000-0000000002c2", "sonda full"))).toBe(1);
  });

  it("recurring_entries: DELETE 0 como support_readonly; a sonda some como full", () => {
    expect(writeCountAs(READONLY_0533, `delete from public.recurring_entries where id = '${RECORRENTE_PROBE_0533}'`)).toBe(0);
    expect(writeCountAs(FULL_0533, `delete from public.recurring_entries where id = '${RECORRENTE_PROBE_0533}'`)).toBe(1);
  });
});