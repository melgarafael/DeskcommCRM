import { beforeAll, describe, expect, it } from "vitest";

import {
  GOV_ADMIN,
  GOV_MANAGER,
  GOV_ORG,
  GOV_SESSION,
  GOV_VIEWER,
  countAs,
  seedGov,
  sql,
  writeCountAs,
} from "./gov-helpers";

/**
 * Migration 0150 — a RLS isolava a organização, mas não aplicava o PAPEL.
 *
 * O `requireRole()` das rotas Next não é a única porta: o PostgREST é exposto ao
 * browser por construção (URL + anon key vão no bundle) e um usuário logado fala
 * com ele direto, com o próprio JWT. Antes desta migration, o papel mais fraco
 * do tenant reescrevia o `system_prompt` do agente — o texto que o bot fala com
 * cliente real —, derrubava o canal de WhatsApp e DELETAVA a credencial de IA.
 *
 * Cada caso vem em par: o papel de baixo é barrado E o papel de cima passa. Um
 * teste só com a metade negativa fica verde se a tabela sumir, se a policy negar
 * todo mundo, ou se a fixture não existir.
 */

const AGENTE_CONFIG = "eeeeeeee-1111-4000-8000-000000000001";
const CRED_CONFIG = "eeeeeeee-2222-4000-8000-000000000001";

function seedConfig(): void {
  sql(`
    insert into public.ai_agents (id, organization_id, name, system_prompt)
      values ('${AGENTE_CONFIG}', '${GOV_ORG}', 'Agente Config', 'PROMPT ORIGINAL')
      on conflict do nothing;
    insert into public.ai_provider_credentials
      (id, organization_id, provider, label, api_key_encrypted, api_key_iv, api_key_tag, api_key_last4)
      values ('${CRED_CONFIG}', '${GOV_ORG}', 'anthropic', 'Chave principal',
              '\\x01'::bytea, '\\x02'::bytea, '\\x03'::bytea, '9999')
      on conflict do nothing;
  `);
}

/** SELECT como `authenticated`, devolvendo se o comando foi PERMITIDO. */
function podeLer(userId: string, select: string): boolean {
  try {
    sql(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
      ${select}
    `);
    return true;
  } catch {
    return false;
  }
}

beforeAll(() => {
  seedGov();
  seedConfig();
});

describe("0150 — escrita de config de IA/canais exige admin", () => {
  it("viewer NÃO reescreve o system_prompt do agente", () => {
    expect(
      writeCountAs(
        GOV_VIEWER,
        `update public.ai_agents set system_prompt = 'SEQUESTRADO' where id = '${AGENTE_CONFIG}'`,
      ),
    ).toBe(0);
  });

  it("manager NÃO reescreve o system_prompt (a rota pede admin — a policy espelha)", () => {
    expect(
      writeCountAs(
        GOV_MANAGER,
        `update public.ai_agents set system_prompt = 'SEQUESTRADO' where id = '${AGENTE_CONFIG}'`,
      ),
    ).toBe(0);
  });

  it("CONTROLE POSITIVO: admin reescreve o system_prompt", () => {
    expect(
      writeCountAs(
        GOV_ADMIN,
        `update public.ai_agents set system_prompt = 'TROCADO PELO ADMIN' where id = '${AGENTE_CONFIG}'`,
      ),
    ).toBe(1);
  });

  it("CONTROLE POSITIVO: viewer continua LENDO o agente (senão a tela quebra)", () => {
    expect(
      countAs(GOV_VIEWER, `select count(*) from public.ai_agents where id = '${AGENTE_CONFIG}';`),
    ).toBe(1);
  });

  it("viewer NÃO derruba o canal de WhatsApp", () => {
    expect(
      writeCountAs(
        GOV_VIEWER,
        `update public.channel_sessions set status = 'STOPPED' where id = '${GOV_SESSION}'`,
      ),
    ).toBe(0);
  });

  it("CONTROLE POSITIVO: admin altera o canal", () => {
    expect(
      writeCountAs(
        GOV_ADMIN,
        `update public.channel_sessions set status = 'STOPPED' where id = '${GOV_SESSION}'`,
      ),
    ).toBe(1);
  });

  it("CONTROLE POSITIVO: viewer continua LENDO o canal", () => {
    expect(
      countAs(
        GOV_VIEWER,
        `select count(*) from public.channel_sessions where id = '${GOV_SESSION}';`,
      ),
    ).toBe(1);
  });
});

describe("0150 — o segredo cifrado some da superfície do browser", () => {
  // O SELECT foi revogado POR COLUNA: as três colunas do segredo saem, as doze
  // que a view consome ficam. Por isso o que se mede aqui é o acesso à COLUNA,
  // não à tabela — `select count(*)` continua permitido e não prova nada.
  it("viewer NÃO lê api_key_encrypted", () => {
    expect(
      podeLer(GOV_VIEWER, `select api_key_encrypted from public.ai_provider_credentials;`),
    ).toBe(false);
  });

  it("admin também NÃO lê api_key_encrypted — nenhum caminho de browser precisa dela", () => {
    expect(
      podeLer(GOV_ADMIN, `select api_key_encrypted from public.ai_provider_credentials;`),
    ).toBe(false);
  });

  it("nem o iv nem o tag saem junto (o trio é o que decifra)", () => {
    expect(podeLer(GOV_ADMIN, `select api_key_iv from public.ai_provider_credentials;`)).toBe(false);
    expect(podeLer(GOV_ADMIN, `select api_key_tag from public.ai_provider_credentials;`)).toBe(
      false,
    );
  });

  it("CONTROLE POSITIVO: a view segura continua legível (é o que a tela consome)", () => {
    expect(
      podeLer(GOV_ADMIN, `select count(*) from public.ai_provider_credentials_safe;`),
    ).toBe(true);
  });

  it("CONTROLE POSITIVO: as colunas não-sensíveis continuam legíveis na tabela base", () => {
    expect(
      podeLer(GOV_ADMIN, `select provider, label, api_key_last4 from public.ai_provider_credentials;`),
    ).toBe(true);
  });

  it("CONTROLE POSITIVO: o servidor (service_role) continua lendo a tabela base", () => {
    const out = sql(`
      set role service_role;
      select count(*) >= 1 from public.ai_provider_credentials where id = '${CRED_CONFIG}';
    `);
    expect(out.trim().endsWith("t")).toBe(true);
  });
});

/**
 * Gate anti-regressão. Nasce VERDE sobre a dívida que existe hoje e vermelho no
 * próximo caso — que é o único jeito de ele viajar junto com a correção em vez
 * de virar 63 falhas que alguém ignora.
 *
 * As tabelas da lista abaixo têm policy `ALL` sem `fn_role_at_least`. A maioria
 * é escrita pelo motor com `service_role` (que bypassa RLS), e apertá-las no
 * mesmo fôlego trocaria um furo por uma parada de produção. Tirar uma daqui só
 * se pode COM o par de casos acima provando papel de baixo barrado e papel de
 * cima passando.
 */
const DIVIDA_RBAC_CONHECIDA = new Set([
  "agent_cases", "agent_inbox_items", "ai_agent_runs", "ai_chunks", "ai_faq_items",
  "ai_invocations", "ai_knowledge_sources", "ai_knowledge_versions", "ai_router_decisions",
  "before_send_traces", "channel_knobs", "channel_session_health", "channel_session_warmup",
  "contact_field_proposals", "contacts", "crm_lead_reactivations", "crm_lead_risk_states",
  "crm_lead_scores", "cron_jobs", "demanda_conversas", "demandas",
  "disclosure_template_pointers", "disclosure_template_versions",
  "flywheel_distiller_proposals", "flywheel_judge_verdicts", "followup_enrollment_events",
  "followup_enrollments", "followup_flow_pointers", "followup_flow_versions",
  "idempotency_keys", "incidents", "job_queue", "judge_alignment_pool", "knowledge_searches",
  "lead_checkpoints", "lead_notes", "lead_state", "lead_state_transitions", "llm_calls",
  "meta_templates", "metrics", "orders", "org_memory_entries",
  "org_memory_pointers", "org_memory_versions", "organizations", "outbound_copies",
  "pacing_ledger", "playbook_pointers", "playbook_versions", "promise_table_pointers",
  "promise_table_versions", "reentry_knob_pointers", "reentry_knob_versions",
  "reentry_template_pointers", "reentry_template_versions", "send_ledger",
  "skill_activations", "skill_pointers", "skill_versions", "storage_redaction_queue",
  "user_recovery_codes",
]);

describe("0150 — a dívida de RBAC não cresce", () => {
  it("as 8 tabelas corrigidas pela 0150 têm policy de escrita com fn_role_at_least", () => {
    const corrigidas = [
      "channel_sessions", "ai_agents", "ai_agent_versions", "ai_budgets",
      "ai_routers", "ai_router_members", "ai_purpose_bindings", "ai_provider_credentials",
    ];
    const semRole = sql(`
      select coalesce(string_agg(distinct tablename, ','), '') from pg_policies
       where schemaname = 'public'
         and tablename in (${corrigidas.map((t) => `'${t}'`).join(",")})
         and cmd = 'ALL'
         and (coalesce(qual, '') || coalesce(with_check, '')) not like '%role_at_least%';
    `);
    expect(semRole.trim()).toBe("");
  });

  it("nenhuma tabela NOVA entra com policy ALL só-tenancy", () => {
    const atuais = sql(`
      select coalesce(string_agg(distinct tablename, ',' order by tablename), '') from pg_policies
       where schemaname = 'public'
         and cmd = 'ALL'
         and (coalesce(qual, '') || coalesce(with_check, '')) not like '%role_at_least%';
    `)
      .trim()
      .split(",")
      .filter(Boolean);

    const novas = atuais.filter((t) => !DIVIDA_RBAC_CONHECIDA.has(t));
    expect(novas).toEqual([]);
  });

  it("CONTROLE: a allowlist não guarda tabela que já não existe (senão ela cobre o futuro por acidente)", () => {
    const existentes = new Set(
      sql(
        `select coalesce(string_agg(distinct tablename, ','), '') from pg_policies where schemaname = 'public';`,
      )
        .trim()
        .split(",")
        .filter(Boolean),
    );
    const fantasmas = [...DIVIDA_RBAC_CONHECIDA].filter((t) => !existentes.has(t));
    expect(fantasmas).toEqual([]);
  });
});
