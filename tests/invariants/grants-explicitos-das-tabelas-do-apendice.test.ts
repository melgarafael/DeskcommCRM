import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { countAs, lastLine, sql, writeCountAs } from "./gov-helpers";

/**
 * AS TABELAS DO APÊNDICE TÊM PRIVILÉGIO EXPLÍCITO, DO TAMANHO DO USO — E CONTINUAM
 * ALCANÇÁVEIS DEPOIS DO CORTE DA SUPABASE DE 30/10/2026 (migration 9037, #3140,
 * decisão 219 = A).
 *
 * A partir de 30/10 a Supabase provisiona o default ACL de `public` revogado: tabela
 * criada sem `GRANT` próprio nasce sem privilégio para `anon`, `authenticated` e
 * `service_role`, e a Data API responde `42501`. A decisão foi NÃO reabrir o default
 * amplo (recusado no #3521 e no #3612) e conceder, por tabela e por papel, o que o uso
 * legítimo pede. `MAPA` abaixo é esse contrato; ele foi medido (ACL atual ∩ comandos
 * com policy PERMISSIVA para `authenticated`), e o cabeçalho da migration diz como.
 *
 * ## Por que um teste de `has_table_privilege` "normal" nasceria verde
 *
 * O banco deste gate tem o default ACL de um projeto Supabase de antes do corte (o
 * prelude de `scripts/test-db.sh` o instala e o corpo do baseline o reemite). Toda
 * tabela já nasce com tudo para os três papéis, então perguntar "authenticated tem
 * SELECT?" mede o mundo de hoje — verde também com a migration apagada. Por isso o
 * corte é SIMULADO (`revoke all` nas tabelas do mapa: é o ACL que uma tabela criada
 * depois de 30/10 teria), e antes de medir a cura o arquivo confere que o corte morde.
 *
 * ## O que se prova
 *
 * 1. Régua derivada do arquivo: a lista de tabelas que o apêndice cria sem `grant`
 *    próprio é o conjunto de EXCEÇÕES declaradas abaixo, nem uma a mais. Tabela nova
 *    sem `grant` reprova aqui, com o que fazer na mensagem.
 * 2. Instalação (baseline aplicado UMA vez, `ON_ERROR_STOP=1`, molde que o
 *    `test-db.sh` tira entre o install e o update) e atualização (DUAS vezes): o ACL
 *    de cada tabela do mapa é EXATAMENTE o do mapa, conferido por `aclexplode` — nada
 *    de TRUNCATE/REFERENCES/TRIGGER, nada para `anon`, nada de coluna.
 * 3. Controle negativo: depois do corte simulado, sem o bloco, `authenticated` e
 *    `service_role` não alcançam nada. Depois, o ARQUIVO da migration e o BLOCO do
 *    apêndice (extraído do baseline, não copiado) devolvem exatamente o mapa — e
 *    reaplicados continuam devolvendo.
 * 4. `anon` negado no comportamento: `set role anon` e `select` recebem `42501`.
 * 5. Isolamento entre duas organizações no mundo pós-corte: cada gerente lê, cria e
 *    altera só o que é da própria organização.
 * 6. `authenticated` nunca recebe comando que a RLS da tabela não pressupõe.
 *
 * A derivação das tabelas do apêndice (`tabelasDoApendiceSemGrantProprio`), o
 * controle negativo do corte e a conferência por `aclexplode` vêm do #3612, de
 * @webtecnica.
 */

const container = process.env.TEST_DB_CONTAINER;
const moldeUmaAplicacao = process.env.TEST_DB_TEMPLATE_UMA_APLICACAO;
if (!container || !moldeUmaAplicacao) {
  throw new Error(
    "TEST_DB_CONTAINER/TEST_DB_TEMPLATE_UMA_APLICACAO ausentes — rode via `pnpm test:db` (scripts/test-db.sh).",
  );
}

const RAIZ = process.cwd();
const DIR_MIGRATIONS = join(RAIZ, "supabase", "migrations");
const SQL_DO_BASELINE = readFileSync(join(RAIZ, "supabase", "baseline.sql"), "utf8");
const ARQUIVO = readdirSync(DIR_MIGRATIONS).find((nome) =>
  /^\d{14}_9037_[a-z0-9_]+\.sql$/.test(nome),
);
if (ARQUIVO === undefined) {
  throw new Error(
    "migration 9037 não encontrada em supabase/migrations/ — renumerada ou removida da cadeia.",
  );
}
const SQL_DA_MIGRATION = readFileSync(join(DIR_MIGRATIONS, ARQUIVO), "utf8");

const DML = ["SELECT", "INSERT", "UPDATE", "DELETE"] as const;
const LE_E_CRIA = ["SELECT", "INSERT"] as const;
const SO_LE = ["SELECT"] as const;
const NADA = [] as const;

/** O contrato: privilégio de `authenticated` por tabela. `service_role` tem as quatro em todas; `anon`, nada. */
const MAPA: Record<string, readonly string[]> = {
  account_plans: DML,
  ai_purpose_bindings: DML,
  attendant_availability: DML,
  automation_rules: DML,
  calendar_appointments: DML,
  calendar_availability_exceptions: DML,
  calendar_event_types: DML,
  contact_field_proposals: DML,
  crm_lead_attachments: DML,
  crm_lead_reactivations: DML,
  crm_lead_risk_states: DML,
  crm_lead_scores: DML,
  demanda_conversas: DML,
  demandas: DML,
  external_db_connections: DML,
  financial_accounts: DML,
  financial_entries: DML,
  lead_field_proposals: DML,
  meta_templates: DML,
  org_guardrail_layers: DML,
  org_voice_calls: DML,
  payment_methods: DML,
  phone_numbers: DML,
  recurring_entries: DML,
  voice_calls: DML,
  voip_trunk_settings: DML,
  webhook_sources: DML,
  automation_rule_runs: DML, // excesso declarado: ver EXCESSO_DECLARADO
  calendar_locations: LE_E_CRIA,
  calendar_connection_calendars: SO_LE,
  calendar_connections: SO_LE,
  calendar_resources: SO_LE,
  calendar_service_blocks: SO_LE,
  calendar_service_calendar_sources: SO_LE,
  calendar_service_occurrence_resources: SO_LE,
  calendar_service_occurrences: SO_LE,
  calendar_service_professionals: SO_LE,
  calendar_service_resources: SO_LE,
  calendar_service_schedule: SO_LE,
  channel_session_groups: SO_LE,
  conversation_assignment_events: SO_LE,
  webhook_lead_captures: SO_LE,
  calendar_oauth_nonces: NADA,
  crm_proposal_counters: NADA,
  mfa_trusted_devices: NADA,
  modulos_instalados: NADA,
  system_update_runs: NADA,
  system_version: NADA,
};
const TABELAS = Object.keys(MAPA).sort();

/** Criadas pelo apêndice sem `grant` próprio, de propósito — cada uma com o porquê. */
const EXCECOES: Record<string, string> = {
  modulo_secoes_lgpd: "fechada a todos os papéis, inclusive service_role (ADR-0002 D8)",
  honorarios_contratos: "módulo opcional: nasce dentro de fn_honorarios_provisionar()",
  honorarios_parcelas: "módulo opcional: nasce dentro de fn_honorarios_provisionar()",
  sales: "módulo opcional: nasce dentro da provisionadora de vendas",
  sale_items: "módulo opcional: nasce dentro da provisionadora de vendas",
  commission_rules: "módulo opcional: nasce dentro da provisionadora de vendas",
  commissions: "módulo opcional: nasce dentro da provisionadora de vendas",
  loyalty_ledger: "módulo opcional: nasce dentro da provisionadora de vendas",
};

/**
 * Privilégio de `authenticated` além do que a RLS pressupõe, mantido de propósito.
 * `webhooks-rls.test.ts` mede a recusa da escrita direta em `automation_rule_runs`
 * como negação da RLS (0 linhas); tirar o privilégio troca essa negação por
 * `permission denied` e reprova aquela medição. Fica como hoje até ela ser revista.
 */
const EXCESSO_DECLARADO: Record<string, string> = {
  automation_rule_runs:
    "webhooks-rls.test.ts mede a recusa de escrita pela RLS, não pelo privilégio",
};

// ── régua derivada do baseline (do #3612, @webtecnica) ─────────────────────────

/** SQL de verdade: sem as linhas de comentário — a prosa cita `create table` e `grant` o tempo todo. */
function semComentario(texto: string): string {
  return texto
    .split("\n")
    .filter((linha) => !linha.trimStart().startsWith("--"))
    .join("\n");
}

/** O apêndice inteiro: do primeiro bloco de complemento (`-- ---- `) ao fim do arquivo. */
function apendiceDoBaseline(): string {
  // sonda-do-baseline: primeira-de-proposito — a fronteira dump/apêndice É a primeira marca; mede ordem de arquivo, não definição.
  const de = SQL_DO_BASELINE.search(/^-- ---- /m);
  if (de === -1)
    throw new Error("apêndice do baseline não encontrado ('-- ---- ' abrindo o complemento).");
  return SQL_DO_BASELINE.slice(de);
}

/** `grant … on public.a, public.b` conta para as duas: o apêndice concede em lista. */
function tabelasDoApendiceSemGrantProprio(): string[] {
  const apendice = semComentario(apendiceDoBaseline());
  const criadas = [
    ...new Set(
      [
        ...apendice.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?public\.([a-z0-9_]+)/gi),
      ].map((m) => (m[1] as string).toLowerCase()),
    ),
  ];
  return criadas
    .filter(
      (t) =>
        !new RegExp(
          `grant\\s+[^;]*\\bon\\s+(?:table\\s+)?(?:[^;]*,\\s*)?public\\.${t}\\b`,
          "i",
        ).test(apendice),
    )
    .sort();
}

/** O bloco da 9037 como ele está NO BASELINE: do rótulo até o rótulo seguinte. */
function blocoDoApendice(): string {
  const rotulo = "-- ---- grants explícitos das tabelas do apêndice (migration 9037) ----";
  const inicio = SQL_DO_BASELINE.indexOf(rotulo);
  if (inicio === -1) throw new Error(`bloco da 9037 não encontrado no baseline ('${rotulo}').`);
  const fim = SQL_DO_BASELINE.indexOf("\n-- ---- ", inicio + rotulo.length);
  if (fim === -1) throw new Error("nenhum bloco depois do da 9037 no baseline.");
  return SQL_DO_BASELINE.slice(inicio, fim);
}

// ── banco ───────────────────────────────────────────────────────────────────────

const BANCO_UMA_APLICACAO = "inv_grants_9037_uma_aplicacao";

function psql(db: string, script: string): string {
  return execFileSync(
    "docker",
    [
      "exec",
      "-i",
      container as string,
      "psql",
      "-U",
      "postgres",
      "-d",
      db,
      "-v",
      "ON_ERROR_STOP=1",
      "-qtA",
      "-f",
      "-",
    ],
    { input: script, encoding: "utf8" },
  ).trim();
}

const LISTA_SQL = TABELAS.map((t) => `'${t}'`).join(",");

/** O ACL de tabela das tabelas do mapa para os três papéis, linha `tabela|papel|privilégio`. */
function aclMedido(db: string): string[] {
  const out = psql(
    db,
    `select c.relname || '|' || r.rolname || '|' || a.privilege_type
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
       cross join lateral aclexplode(c.relacl) a
       join pg_roles r on r.oid = a.grantee
      where c.relname in (${LISTA_SQL})
        and r.rolname in ('anon', 'authenticated', 'service_role')
      order by 1;`,
  );
  return out === "" ? [] : out.split("\n");
}

function aclEsperado(): string[] {
  const linhas: string[] = [];
  for (const t of TABELAS) {
    for (const p of MAPA[t] as readonly string[]) linhas.push(`${t}|authenticated|${p}`);
    for (const p of DML) linhas.push(`${t}|service_role|${p}`);
  }
  return linhas.sort();
}

function colunasComAcl(db: string): string {
  return psql(
    db,
    `select count(*) from pg_attribute at
       join pg_class c on c.oid = at.attrelid
       join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
      where c.relname in (${LISTA_SQL}) and at.attacl is not null;`,
  );
}

/** O que a plataforma faz numa tabela criada depois de 30/10/2026: nada para os três papéis. */
function simulaOCorte(): void {
  sql(
    TABELAS.map(
      (t) => `revoke all on table public.${t} from anon, authenticated, service_role;`,
    ).join("\n"),
  );
}

function alcancaveis(papel: string): string[] {
  const out = sql(
    `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
      where c.relname in (${LISTA_SQL}) and has_table_privilege('${papel}', c.oid, 'select') order by 1;`,
  );
  return out === "" ? [] : out.split("\n");
}

beforeAll(() => {
  psql(
    "template1",
    `drop database if exists ${BANCO_UMA_APLICACAO} with (force);\ncreate database ${BANCO_UMA_APLICACAO} template ${moldeUmaAplicacao};\n`,
  );
});

afterAll(() => {
  psql("template1", `drop database if exists ${BANCO_UMA_APLICACAO} with (force);\n`);
});

describe("grants explícitos das tabelas do apêndice (9037)", () => {
  it("a régua sai do baseline: toda tabela do apêndice tem grant próprio ou é exceção declarada", () => {
    const semGrant = tabelasDoApendiceSemGrantProprio();
    const naoDeclaradas = semGrant.filter((t) => !(t in EXCECOES));
    expect(
      naoDeclaradas,
      "tabela criada no apêndice do baseline sem `grant … on public.<tabela>` próprio. Depois de 30/10/2026 " +
        "ela nasce inalcançável pela Data API na Supabase da nuvem: escreva o grant do tamanho do uso " +
        "(authenticated só com os comandos que a RLS pressupõe, service_role com o que o servidor faz, anon " +
        "só com policy pública), ou declare a exceção em EXCECOES com o porquê.",
    ).toEqual([]);
    // As exceções não podem envelhecer: a que ganhou grant sai da lista.
    expect(
      Object.keys(EXCECOES).sort(),
      "exceção declarada que já tem grant próprio — tire-a de EXCECOES.",
    ).toEqual(semGrant);
    // Nenhuma tabela do mapa é exceção, e o parser não está lendo prosa: o mapa existe no banco.
    expect(TABELAS.filter((t) => t in EXCECOES)).toEqual([]);
    expect(
      Number(
        sql(`select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity and c.relname in (${LISTA_SQL});`),
      ),
    ).toBe(TABELAS.length);
  });

  it("instalação (baseline aplicado UMA vez): o ACL é exatamente o do mapa", () => {
    const aplicacoes = psql(
      BANCO_UMA_APLICACAO,
      "select count(*) from test_db.aplicacoes_do_baseline;",
    );
    expect(
      aplicacoes,
      "o banco medido não é o de uma aplicação do baseline — o teste mediria a atualização.",
    ).toBe("1");
    expect(aclMedido(BANCO_UMA_APLICACAO)).toEqual(aclEsperado());
    expect(colunasComAcl(BANCO_UMA_APLICACAO)).toBe("0");
  });

  it("atualização (baseline aplicado DUAS vezes): o ACL é exatamente o do mapa", () => {
    expect(sql("select count(*) from test_db.aplicacoes_do_baseline;")).toBe("2");
    expect(aclMedido("postgres")).toEqual(aclEsperado());
    expect(colunasComAcl("postgres")).toBe("0");
  });

  it("controle negativo: depois do corte, sem o bloco, authenticated e service_role não alcançam nada", () => {
    simulaOCorte();
    expect(
      alcancaveis("authenticated"),
      "o corte simulado não morde — o resto do arquivo não provaria nada.",
    ).toEqual([]);
    expect(alcancaveis("service_role")).toEqual([]);
    expect(aclMedido("postgres")).toEqual([]);
  });

  it("⭐ o ARQUIVO da migration devolve, depois do corte, exatamente o mapa — e reaplicado também", () => {
    simulaOCorte();
    sql(SQL_DA_MIGRATION);
    expect(aclMedido("postgres")).toEqual(aclEsperado());
    sql(SQL_DA_MIGRATION);
    expect(aclMedido("postgres")).toEqual(aclEsperado());
  });

  it("⭐ o BLOCO do apêndice (extraído do baseline) devolve, depois do corte, exatamente o mapa", () => {
    simulaOCorte();
    sql(blocoDoApendice());
    expect(aclMedido("postgres")).toEqual(aclEsperado());
    sql(blocoDoApendice());
    expect(aclMedido("postgres")).toEqual(aclEsperado());
  });

  it("anon é negado no comportamento: select como anon recebe permission denied", () => {
    simulaOCorte();
    sql(blocoDoApendice());
    const negadas = sql(`
      do $p$
      declare t text; n int := 0;
      begin
        set local role anon;
        foreach t in array array[${LISTA_SQL}] loop
          begin
            execute format('select 1 from public.%I limit 1', t);
          exception when insufficient_privilege then n := n + 1;
          end;
        end loop;
        reset role;
        create temp table if not exists _negadas_9037 (n int);
        delete from _negadas_9037;
        insert into _negadas_9037 values (n);
      end $p$;
      select n from _negadas_9037;
    `);
    expect(lastLine(negadas)).toBe(String(TABELAS.length));
  });

  it("authenticated nunca recebe comando que a RLS da tabela não pressupõe (policy permissiva)", () => {
    const out = sql(`
      select p.tablename || '|' || p.cmd from pg_policies p
       where p.schemaname = 'public' and p.tablename in (${LISTA_SQL}) and p.permissive = 'PERMISSIVE'
         and p.roles && array['public', 'authenticated']::name[];`);
    const cobertos = new Set<string>();
    for (const linha of out === "" ? [] : out.split("\n")) {
      const [t, cmd] = linha.split("|") as [string, string];
      for (const c of cmd === "ALL" ? DML : [cmd]) cobertos.add(`${t}|${c}`);
    }
    const semPolicy = TABELAS.flatMap((t) =>
      (MAPA[t] as readonly string[]).map((p) => `${t}|${p}`),
    ).filter((x) => !cobertos.has(x) && !((x.split("|")[0] as string) in EXCESSO_DECLARADO));
    expect(
      semPolicy,
      "privilégio de authenticated sem policy permissiva que o use — está maior que o uso.",
    ).toEqual([]);
  });

  describe("isolamento entre duas organizações, no mundo pós-corte", () => {
    const ORG_A = "9037aaaa-0000-4000-8000-000000000001";
    const ORG_B = "9037bbbb-0000-4000-8000-000000000001";
    const GERENTE_A = "9037aaaa-1111-4000-8000-000000000001";
    const GERENTE_B = "9037bbbb-1111-4000-8000-000000000001";
    const CONTA_A = "9037aaaa-2222-4000-8000-000000000001";
    const CONTA_B = "9037bbbb-2222-4000-8000-000000000001";

    beforeAll(() => {
      simulaOCorte();
      sql(SQL_DA_MIGRATION);
      sql(`
        insert into auth.users (id, email) values
          ('${GERENTE_A}', 'grants-9037-a@invariant.test'), ('${GERENTE_B}', 'grants-9037-b@invariant.test')
          on conflict do nothing;
        insert into public.organizations (id, slug, legal_name, display_name) values
          ('${ORG_A}', 'grants-9037-a', 'Org A 9037', 'Org A'), ('${ORG_B}', 'grants-9037-b', 'Org B 9037', 'Org B')
          on conflict do nothing;
        insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
          ('${GERENTE_A}', '${ORG_A}', 'manager', now()), ('${GERENTE_B}', '${ORG_B}', 'manager', now())
          on conflict do nothing;
        insert into public.financial_accounts (id, organization_id, name) values
          ('${CONTA_A}', '${ORG_A}', 'Caixa A'), ('${CONTA_B}', '${ORG_B}', 'Caixa B')
          on conflict do nothing;
      `);
    });

    it("cada gerente lê só a conta da própria organização", () => {
      expect(countAs(GERENTE_A, "select count(*) from public.financial_accounts;")).toBe(1);
      expect(
        countAs(
          GERENTE_A,
          `select count(*) from public.financial_accounts where id = '${CONTA_B}';`,
        ),
      ).toBe(0);
      expect(
        countAs(
          GERENTE_B,
          `select count(*) from public.financial_accounts where id = '${CONTA_A}';`,
        ),
      ).toBe(0);
    });

    it("cada gerente cria e altera na própria organização, e não alcança a outra", () => {
      expect(
        writeCountAs(
          GERENTE_A,
          `insert into public.financial_accounts (organization_id, name) values ('${ORG_A}', 'Banco A')`,
        ),
      ).toBe(1);
      expect(
        writeCountAs(
          GERENTE_A,
          `insert into public.financial_accounts (organization_id, name) values ('${ORG_B}', 'Intrusa')`,
        ),
      ).toBe(0);
      expect(
        writeCountAs(
          GERENTE_A,
          `update public.financial_accounts set name = 'X' where id = '${CONTA_B}'`,
        ),
      ).toBe(0);
      expect(
        writeCountAs(
          GERENTE_B,
          `update public.financial_accounts set name = 'Caixa B2' where id = '${CONTA_B}'`,
        ),
      ).toBe(1);
      expect(
        sql(`select count(*) from public.financial_accounts where organization_id = '${ORG_B}';`),
      ).toBe("1");
    });
  });
});
