import { describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";
import { TABLES } from "./rls-isolation.test";

/**
 * VARREDURA de completude de RLS — o buraco que o próprio `rls-isolation.test.ts`
 * confessa no cabeçalho da sua lista `TABLES` (linha ~208):
 *
 *     ⚠️ LISTA FIXA — tabela tenant-aware nova que NÃO entrar aqui passa verde
 *     sem RLS. Não existe varredura genérica do tipo "toda tabela com
 *     organization_id tem relrowsecurity = true".
 *
 * ## Por que NÃO basta olhar só o catálogo (`relrowsecurity` + "tem policy")
 *
 * Porque uma policy pode estar sabotada e ainda assim passar em qualquer
 * checagem de catálogo. Medido de verdade neste repo: `org_guardrail_layers`
 * tinha `relrowsecurity = true` e uma policy — e a policy dizia
 * `organization_id in (select fn_user_org_ids()) or true`, que devolve a
 * organização INTEIRA do vizinho. RLS ligada e policy presente não é isolamento;
 * é só a forma que o isolamento tem que ter. A prova real só existe simulando o
 * JWT de um usuário de verdade e CONTANDO linhas cross-tenant — o que
 * `rls-isolation.test.ts` já faz, por tabela, na lista `TABLES`.
 *
 * ## O que ESTA varredura fecha, então
 *
 * `TABLES` é mantida à mão. Quem cria uma tabela nova com `organization_id` e
 * esquece de acrescentar a linha ali (no MESMO commit da migration, como o
 * comentário de lá já pede) não quebra nada: o CI segue verde, e a tabela fica
 * sem NENHUMA prova de isolamento — nem de catálogo, nem de comportamento.
 * Ninguém percebe até alguém vazar dado do vizinho em produção.
 *
 * Esta varredura DERIVA a lista de tabelas tenant-aware do catálogo (não há o
 * que esquecer de acrescentar) e reprova qualquer uma que não apareça em
 * `TABLES` nem numa exceção nomeada — forçando toda tabela nova a ganhar o
 * teste comportamental de verdade antes que o gate deixe passar.
 *
 * ## As duas listas de exceção, e por que são duas coisas diferentes
 *
 * Não existe uma varredura anterior a esta, então aplicar a regra "está em
 * TABLES ou reprova" de uma vez batia em 73 tabelas que já existem hoje, têm
 * RLS ligada, mas nunca ganharam um teste `set role authenticated` + contagem
 * cross-org num arquivo dedicado — dívida herdada, não introduzida por esta
 * mudança. Fingir que elas "passam" seria mentir; fazer o gate nascer vermelho
 * em 73 tabelas de uma vez não é tratável nesta sessão (cada uma exigiria seed
 * + fixture própria). A saída honesta é DISTINGUIR as duas classes:
 *
 *   - `PROVA_PROPRIA`: tabela fora de `TABLES`, mas com teste comportamental
 *     real (JWT simulado + contagem cross-org) em outro arquivo — o mesmo
 *     padrão de `webhook_lead_captures`, que já vivia assim antes desta
 *     varredura existir. Cada entrada cita o arquivo que prova.
 *   - `DEBITO_CONHECIDO`: tabela SEM prova comportamental nenhuma, encontrada
 *     por esta varredura no dia em que ela nasceu (2026-08-27). Não é uma
 *     declaração de segurança — é a fotografia da dívida, para o gate proteger
 *     dali para frente sem fingir que o passado está resolvido. Tabela NOVA
 *     nunca entra aqui: entra em `TABLES` ou em `PROVA_PROPRIA`, com teste de
 *     verdade. Reduzir esta lista com o tempo (escrevendo o teste que falta e
 *     movendo a tabela para `TABLES`) é o caminho — não engordá-la.
 *
 * Em ambas, `relrowsecurity = true` é reconferido pela própria varredura: uma
 * exceção — de qualquer das duas listas — cuja tabela sumiu ou perdeu RLS
 * reprova, na hora, em vez de continuar "documentando" uma proteção que já não
 * existe.
 */

interface Excecao {
  readonly tabela: string;
  readonly razao: string;
}

/**
 * Tabelas fora de `TABLES` com teste comportamental de verdade em outro
 * arquivo — verificado lendo cada um: `set role authenticated` (ou
 * `countAs`/`writeCountAs`, que fazem o mesmo) + JWT do usuário + contagem de
 * linhas da OUTRA organização, não uma leitura como superusuário.
 */
const PROVA_PROPRIA: readonly Excecao[] = [
  {
    tabela: "webhook_lead_captures",
    razao:
      "tests/invariants/historico-de-captacao-rls.test.ts prova isolamento " +
      "cross-tenant E o gate de papel (viewer não lê). Fica fora de TABLES " +
      "de propósito: o usuário semeado em rls-isolation.test.ts é `agent`, e " +
      "a policy desta tabela exige `manager` — o controle positivo falharia " +
      "por ACERTO ali.",
  },
  {
    tabela: "meta_templates",
    razao:
      "tests/invariants/meta-templates-rls.test.ts (\"membro da org B NÃO vê " +
      "o template da org A\") prova isolamento com `countAs` real.",
  },
  {
    tabela: "webhook_sources",
    razao:
      "tests/invariants/webhooks-rls.test.ts (\"manager B (org B) NÃO vê " +
      "webhook_source/automation_rule da org A\") prova isolamento com " +
      "`countAs` real.",
  },
  {
    tabela: "automation_rules",
    razao: "tests/invariants/webhooks-rls.test.ts — mesmo caso da linha acima.",
  },
  {
    tabela: "automation_rule_runs",
    razao:
      "tests/invariants/webhooks-rls.test.ts (\"service_role insere " +
      "automation_rule_runs na org A; manager B não vê, manager A vê\").",
  },
  {
    tabela: "calendar_event_types",
    razao:
      "tests/invariants/agenda-rls.test.ts — `TABELAS_DA_AGENDA`, com " +
      "`it.each` provando 0 linhas cross-org nos dois sentidos (A→B e B→A).",
  },
  {
    tabela: "calendar_appointments",
    razao: "tests/invariants/agenda-rls.test.ts — mesmo `it.each` de TABELAS_DA_AGENDA.",
  },
  {
    tabela: "calendar_availability_exceptions",
    razao: "tests/invariants/agenda-rls.test.ts — mesmo `it.each` de TABELAS_DA_AGENDA.",
  },
  {
    tabela: "calendar_connections",
    razao:
      "tests/invariants/agenda-rls.test.ts — TABELAS_DA_AGENDA prova o " +
      "isolamento cross-org, e o describe seguinte (\"o gate de papel que as " +
      "outras cinco não têm\") ainda prova o gate de dono/role por cima.",
  },
  {
    tabela: "calendar_connection_calendars",
    razao: "tests/invariants/agenda-rls.test.ts — mesmo `it.each` de TABELAS_DA_AGENDA.",
  },
  {
    tabela: "calendar_external_events",
    razao: "tests/invariants/agenda-rls.test.ts — mesmo `it.each` de TABELAS_DA_AGENDA.",
  },
  {
    tabela: "followup_flow_versions",
    razao:
      "tests/invariants/followup-schema.test.ts — `FOLLOWUP_TABLES`, com " +
      "\"user of org A reads 0 rows of org B\" por tabela (mesmo molde de " +
      "rls-isolation.test.ts).",
  },
  {
    tabela: "followup_flow_pointers",
    razao: "tests/invariants/followup-schema.test.ts — mesmo laço de FOLLOWUP_TABLES.",
  },
  {
    tabela: "followup_enrollments",
    razao: "tests/invariants/followup-schema.test.ts — mesmo laço de FOLLOWUP_TABLES.",
  },
  {
    tabela: "followup_enrollment_events",
    razao: "tests/invariants/followup-schema.test.ts — mesmo laço de FOLLOWUP_TABLES.",
  },
  {
    tabela: "user_organizations",
    razao:
      "tests/invariants/gov-1b-team-manager-read.test.ts (\"cross-org: " +
      "manager da org A NÃO lê linhas da org B (0 rows)\") prova isolamento " +
      "com `countAs` real, além do self-read do agent.",
  },
  // ─── As três do eixo de anúncios (migrations 0213/0214) ───
  //
  // ⚠️ PROVA DE OUTRO TIPO, e a diferença está escrita de propósito: as demais
  // entradas desta lista citam um teste que SIMULA JWT e CONTA linhas cross-org.
  // Estas três não contam linha nenhuma — elas provam que `authenticated` não
  // alcança a tabela DE JEITO NENHUM (privilégio NENHUM em
  // `role_table_grants` + `permission denied` medido sob `set role`), que é a
  // postura de `platform_google_oauth` (0201): RLS ligada, ZERO policies,
  // grants revogados de anon/authenticated.
  //
  // É MAIS restritivo que isolamento por tenant, não menos: sem privilégio não
  // há regra para errar. E é por isso que elas não podem entrar em `TABLES` —
  // lá o `countAs` receberia `permission denied` em vez de `0`, o caso ficaria
  // vermelho, e a "correção" natural seria criar uma policy: isto é, passar a
  // SERVIR pelo PostgREST justamente a tabela que guarda o token da conta de
  // anúncios do cliente. O teste citado tem um caso que reprova essa migração.
  //
  // NÃO é DEBITO_CONHECIDO: há prova comportamental, escrita no mesmo PR.
  {
    tabela: "ad_platform_connections",
    razao:
      "tests/invariants/credencial-de-anuncios-e-server-side.test.ts — privilégio " +
      "NENHUM para anon e authenticated, `permission denied` medido sob `set role`, " +
      "RLS ligada, zero policies, e `organization_id` NOT NULL com FK em cascata. " +
      "Deny-all em vez de policy de tenant porque a linha guarda o token que ESCREVE " +
      "conversões na conta de anúncios do cliente.",
  },
  {
    tabela: "ad_insights_connections",
    razao:
      "tests/invariants/credencial-de-anuncios-e-server-side.test.ts — mesmo " +
      "`describe.each` da linha acima. Guarda o token `ads_read`, que expõe " +
      "orçamento, criativo e performance de quem anuncia.",
  },
  {
    tabela: "ad_conversion_dispatches",
    razao:
      "tests/invariants/credencial-de-anuncios-e-server-side.test.ts — mesmo " +
      "`describe.each`. Não guarda segredo, mas é o livro-razão de quais leads " +
      "da organização viraram venda, e quem o lê é o servidor com o admin client " +
      "filtrando organization_id à mão (a tela `/app/settings/conversoes`).",
  },
];

/**
 * Dívida herdada — sem teste comportamental, fotografada em 2026-08-27 por
 * esta própria varredura. Ver o cabeçalho do arquivo: NÃO adicione tabela nova
 * aqui. Tabela nova entra em `TABLES` (rls-isolation.test.ts) com teste real,
 * ou em `PROVA_PROPRIA` acima, citando o arquivo que prova.
 */
const RAZAO_DEBITO_CONHECIDO =
  "sem teste comportamental (JWT simulado + contagem cross-org) em nenhum " +
  "arquivo no dia em que esta varredura nasceu (2026-08-27); relrowsecurity " +
  "= true confirmado pela própria varredura, mas isso NÃO é prova de " +
  "isolamento (ver cabeçalho do arquivo). Dívida herdada, não introduzida " +
  "por esta mudança — não é declaração de que a tabela está segura.";

const DEBITO_CONHECIDO: readonly Excecao[] = [
  "agent_case_events",
  "agent_cases",
  "agent_inbox_items",
  "ai_agent_runs",
  "ai_agent_versions",
  "ai_agents",
  "ai_budgets",
  "ai_chunks",
  "ai_faq_items",
  "ai_invocations",
  "ai_knowledge_sources",
  "ai_knowledge_versions",
  "ai_provider_credentials",
  "ai_purpose_bindings",
  "ai_router_members",
  "api_audit_log",
  "api_tokens",
  "attendant_availability",
  "before_send_traces",
  "calendar_oauth_nonces",
  "channel_knobs",
  "channel_session_health",
  "channel_session_warmup",
  "channel_sessions",
  "conversation_assignment_events",
  "conversation_notes",
  "crm_lead_activities",
  "crm_lead_links",
  "crm_lead_reactivations",
  "crm_lead_risk_states",
  "crm_lead_scores",
  "crm_pipelines",
  "crm_stages",
  "cron_jobs",
  "demanda_conversas",
  "demandas",
  "disclosure_template_pointers",
  "disclosure_template_versions",
  "event_log",
  "flywheel_distiller_proposals",
  "flywheel_judge_verdicts",
  "idempotency_keys",
  "incidents",
  "job_queue",
  "judge_alignment_pool",
  "lead_checkpoints",
  "lead_notes",
  "lead_state",
  "lead_state_transitions",
  "lgpd_requests",
  "llm_calls",
  "merge_queue",
  "message_templates",
  "metrics",
  "nuvemshop_products",
  "orders",
  "org_memory_pointers",
  "outbound_copies",
  "pacing_ledger",
  "playbook_pointers",
  "playbook_versions",
  "promise_table_pointers",
  "promise_table_versions",
  "reentry_knob_pointers",
  "reentry_knob_versions",
  "reentry_template_pointers",
  "reentry_template_versions",
  "send_ledger",
  "skill_pointers",
  "skill_versions",
  "storage_redaction_queue",
  "tenant_integrations",
  "webhook_events_log",
].map((tabela) => ({ tabela, razao: RAZAO_DEBITO_CONHECIDO }));

interface TabelaOrg {
  readonly tabela: string;
  readonly rlsLigada: boolean;
}

/** Toda tabela BASE de `public` que tem uma coluna `organization_id`. */
function inventario(): TabelaOrg[] {
  const out = sql(`
    select c.relname || '\t' || c.relrowsecurity::text
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid
                         and a.attname = 'organization_id' and a.attnum > 0
     where n.nspname = 'public' and c.relkind = 'r'
     order by 1;
  `);
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .map((linha) => {
      // `relrowsecurity::text` — CAST explícito — produz 'true'/'false', não
      // o 't'/'f' que o psql imprime para uma coluna boolean CRUA. Comparar
      // com "t" (o hábito de quem já leu boolean de psql direto) reprova toda
      // tabela em massa por instrumento cego, não por RLS desligada — foi
      // medido rodando este arquivo. `hardening-definer-varredura.test.ts` já
      // acerta isso comparando com "true"; aqui é o mesmo cast.
      const [tabela, rls] = linha.split("\t");
      return { tabela: (tabela ?? "").trim(), rlsLigada: (rls ?? "").trim() === "true" };
    });
}

describe("varredura: completude de RLS sobre toda tabela com organization_id", () => {
  it("o inventário não vem vazio (guarda de vacuidade)", () => {
    // Mesma razão de ser do caso análogo em hardening-definer-varredura.test.ts:
    // sem isto, um catálogo que deixasse de casar (coluna renomeada, schema
    // trocado) faria as asserções abaixo passarem por AUSÊNCIA de dado. O
    // número é o medido em 2026-08-27 (102 tabelas); a asserção é de ordem de
    // grandeza, não de igualdade, para não reprovar a cada tabela nova.
    expect(inventario().length).toBeGreaterThanOrEqual(90);
  });

  it("toda tabela com organization_id tem row level security LIGADA", () => {
    const sem = inventario()
      .filter((t) => !t.rlsLigada)
      .map((t) => t.tabela);
    expect(
      sem,
      "Tabela com `organization_id` e SEM RLS: alcançável pelo PostgREST com " +
        "a anon key + o JWT de qualquer usuário logado. Acrescente `alter " +
        "table ... enable row level security` na migration.",
    ).toEqual([]);
  });

  it("toda tabela tenant-aware tem prova comportamental — está em TABLES ou é exceção nomeada", () => {
    // Este é o caso que fecha o buraco de verdade: RLS ligada (caso acima) não
    // é isolamento provado — só a forma que o isolamento tem que ter. Uma
    // tabela só passa aqui se estiver em TABLES (teste comportamental de
    // verdade), em PROVA_PROPRIA (teste comportamental em outro arquivo,
    // citado) ou em DEBITO_CONHECIDO (dívida herdada, fotografada — não uma
    // aprovação).
    const conhecidas = new Set<string>([
      ...TABLES,
      ...PROVA_PROPRIA.map((e) => e.tabela),
      ...DEBITO_CONHECIDO.map((e) => e.tabela),
    ]);
    const semRegistro = inventario()
      .map((t) => t.tabela)
      .filter((tabela) => !conhecidas.has(tabela));
    expect(
      semRegistro,
      "Tabela tenant-aware NOVA sem prova comportamental nenhuma. Acrescente " +
        "a tabela em TABLES (tests/invariants/rls-isolation.test.ts) com um " +
        "teste `set role authenticated` + JWT + contagem cross-org, no MESMO " +
        "commit da migration — ou, se já existir teste assim em outro " +
        "arquivo, declare em PROVA_PROPRIA (neste arquivo) citando-o. NÃO " +
        "acrescente em DEBITO_CONHECIDO: aquela lista é só a dívida herdada " +
        "de antes desta varredura existir.",
    ).toEqual([]);
  });

  it("as exceções de PROVA_PROPRIA ainda existem e ainda têm RLS ligada", () => {
    // As duas mortes de sempre: exceção para tabela que sumiu vira ruído que
    // ninguém apaga; exceção para tabela que perdeu RLS finge segurança que já
    // não existe.
    const porTabela = new Map(inventario().map((t) => [t.tabela, t]));
    for (const { tabela } of PROVA_PROPRIA) {
      const achada = porTabela.get(tabela);
      expect(achada, `PROVA_PROPRIA cita tabela inexistente: ${tabela}`).toBeDefined();
      expect(
        achada?.rlsLigada,
        `${tabela} está em PROVA_PROPRIA mas perdeu RLS — não é mais exceção, é tabela exposta`,
      ).toBe(true);
    }
  });

  it("as exceções de DEBITO_CONHECIDO ainda existem e ainda têm RLS ligada", () => {
    const porTabela = new Map(inventario().map((t) => [t.tabela, t]));
    for (const { tabela } of DEBITO_CONHECIDO) {
      const achada = porTabela.get(tabela);
      expect(achada, `DEBITO_CONHECIDO cita tabela inexistente: ${tabela} — remova a entrada`).toBeDefined();
      expect(
        achada?.rlsLigada,
        `${tabela} está em DEBITO_CONHECIDO mas perdeu RLS — isto não é mais só falta de teste, é tabela exposta`,
      ).toBe(true);
    }
  });
});
