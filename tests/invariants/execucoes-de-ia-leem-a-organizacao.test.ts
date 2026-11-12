import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { countAs, lastLine, sql } from "./gov-helpers";

/**
 * IA › Execuções e Custo da IA LEEM — na sessão do usuário, não no admin (#4527).
 *
 * ─── O defeito, medido na instalação do membro ───────────────────────────────
 *
 * `llm_calls` com as 73 chamadas no banco, `relrowsecurity = true` e só as
 * restritivas `support_write_*`: sem NENHUMA policy permissiva, a sessão do
 * usuário lê 0 linha. As duas telas leem com a sessão:
 *
 *   - `/app/ai/runs` → `app/api/v1/ai/runs/route.ts` (`createClient()` +
 *     `.eq("organization_id", …)`) — lista vazia;
 *   - "Custo da IA no período" → `app/api/v1/ai/usage/route.ts` chama
 *     `fn_uso_de_ia`, que é `security invoker` e SOMA de `llm_calls` — US$ 0,00.
 *
 * Nenhuma das duas estava quebrada: a permissão de leitura é que não existia. A
 * prova deste arquivo é a CONSULTA DAS TELAS, com o mesmo JWT — não a migration
 * aplicada. Policy presente e tela vazia continuaria sendo defeito.
 *
 * ─── O que este arquivo prova ────────────────────────────────────────────────
 *
 *   1. a instalação que o baseline/update entrega tem policy de leitura
 *      permissiva nas três tabelas da 0050 (catálogo, com o nome da rotina que
 *      não as cura);
 *   2. o membro lê as execuções da PRÓPRIA organização (consulta da rota);
 *   3. o custo agregado é o dos dados da organização, não zero (RPC da tela);
 *   4. a leitura é POR ORGANIZAÇÃO, nos dois sentidos — vizinho lê 0;
 *   5. reconstruindo o estado da instalação (policy permissiva derrubada), o
 *      membro lê 0 e o service role lê as MESMAS linhas; e reaplicar a
 *      migration 9362 devolve a leitura — duas vezes, porque `update.sh` roda em
 *      banco que pode já ter uma policy parcial.
 */

const MIGRATION = join(
  process.cwd(),
  "supabase",
  "migrations",
  "20261112200947_9362_reparar_leitura_de_llm_calls.sql",
);

const ORG_A = "eeeeeeee-0000-4000-8000-000000000001";
const ORG_B = "eeeeeeee-0000-4000-8000-000000000002";
const USER_A = "eeeeeeee-1111-4000-8000-000000000001";
const USER_B = "eeeeeeee-1111-4000-8000-000000000002";

const CUSTO_A_CENTS = 350;

/** Roda a consulta como a sessão do usuário (role + claims), devolvendo a última linha. */
function asUser(userId: string, query: string): string {
  return lastLine(
    sql(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
      ${query}
    `),
  );
}

/** O `select` da rota de Execuções, coluna por coluna, com o filtro dela. */
function consultaDaTelaDeExecucoes(org: string): string {
  return `
    select id, purpose, provider, model, status, error_code, error_message, http_status,
           origem_da_escolha, input_tokens, output_tokens, cost_cents, latency_ms, created_at
      from public.llm_calls
     where organization_id = '${org}'
     order by created_at desc
     limit 100;
  `;
}

/** O que a tela de custo lê: a RPC `fn_uso_de_ia` (security invoker). */
function consultaDoCusto(org: string): string {
  return `select public.fn_uso_de_ia('${org}', now() - interval '30 days', now() + interval '1 day', null, null)::text;`;
}

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${USER_A}', 'exec-ia-a@invariant.test'),
      ('${USER_B}', 'exec-ia-b@invariant.test')
    on conflict (id) do nothing;

    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'exec-ia-a', 'Exec IA A', 'Exec IA A'),
      ('${ORG_B}', 'exec-ia-b', 'Exec IA B', 'Exec IA B')
    on conflict (id) do nothing;

    -- manager: é o papel mínimo que a tela de Execuções aceita
    -- (app/app/ai/runs/page.tsx) e o mesmo que a rota exige.
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${USER_A}', '${ORG_A}', 'manager', now()),
      ('${USER_B}', '${ORG_B}', 'manager', now())
    on conflict do nothing;

    insert into public.llm_calls
      (id, organization_id, purpose, provider, model, input_tokens, output_tokens, cost_cents, latency_ms, status, created_at)
    values
      ('eeeeeeee-9999-4000-8000-000000000001', '${ORG_A}', 'agent_turn', 'openai', 'gpt-ficticio', 1200, 300, 200, 900, 'ok', now() - interval '2 hours'),
      ('eeeeeeee-9999-4000-8000-000000000002', '${ORG_A}', 'classifier', 'openai', 'gpt-ficticio', 400, 40, 150, 300, 'erro', now() - interval '1 hour'),
      ('eeeeeeee-9999-4000-8000-000000000003', '${ORG_B}', 'agent_turn', 'openai', 'gpt-ficticio', 999, 111, 780, 800, 'ok', now() - interval '3 hours')
    on conflict (id) do nothing;
  `);
  sql(`update public.llm_calls set error_code = 'credential_denied', error_message = 'recusado (fictício)'
        where id = 'eeeeeeee-9999-4000-8000-000000000002';`);
});

describe("IA › Execuções e Custo da IA leem na sessão do usuário (#4527)", () => {
  it("controle: as linhas das duas organizações existem no banco", () => {
    // Sem este controle, um seed que não gravou nada faria todo caso abaixo
    // passar por vacuidade — inclusive os de isolamento, que esperam zero.
    expect(sql(`select count(*)::text from public.llm_calls where organization_id = '${ORG_A}'`)).toBe("2");
    expect(sql(`select count(*)::text from public.llm_calls where organization_id = '${ORG_B}'`)).toBe("1");
  });

  it("a instalação que sai do baseline/update tem policy de leitura PERMISSIVA nas três tabelas da 0050", () => {
    // A causa do defeito está no catálogo: `fn_proteger_tabelas_de_organizacao()`
    // (0325) só age em tabela com `relrowsecurity = false`, e
    // `fn_aplicar_travas_de_suporte()` (0274) só acrescenta as restritivas. Uma
    // tabela com RLS ligada e ZERO policy permissiva fica presa nesse estado para
    // sempre — e é exatamente o que este caso recusa.
    const linhas = sql(`
      select p.tablename || ' ' || p.cmd || ' ' || p.permissive
        from pg_policies p
       where p.schemaname = 'public'
         and p.tablename in ('llm_calls', 'before_send_traces', 'flywheel_judge_verdicts')
         and p.permissive = 'PERMISSIVE'
         and p.cmd in ('ALL', 'SELECT')
       order by 1;
    `);
    for (const tabela of ["llm_calls", "before_send_traces", "flywheel_judge_verdicts"]) {
      expect(
        linhas,
        `${tabela} está com RLS ligada e sem policy permissiva de leitura: a sessão do usuário lê 0 linha. ` +
          "A varredura da 0325 pula esta tabela (ela só age com RLS desligada) — o conserto é a migration 9362.",
      ).toContain(tabela);
    }
  });

  it("o membro lê as execuções da própria organização — a consulta da tela, coluna por coluna", () => {
    const linhas = sql(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${USER_A}"}', false);
      ${consultaDaTelaDeExecucoes(ORG_A)}
    `)
      .split("\n")
      .filter((l) => l.trim() !== "");
    // Uma linha por execução (mais o eco do set_config, que não tem pipe).
    expect(linhas.filter((l) => l.includes("|")).length).toBe(2);
    // O "o que deu errado" da tela: a falha vem com código e mensagem.
    expect(linhas.some((l) => l.includes("classifier") && l.includes("credential_denied"))).toBe(true);
  });

  it("o Custo da IA não é zero — a RPC da tela soma as chamadas da organização", () => {
    const uso = JSON.parse(asUser(USER_A, consultaDoCusto(ORG_A))) as {
      totais: { chamadas: number; custo_cents: number };
    };
    expect(uso.totais.chamadas).toBe(2);
    expect(uso.totais.custo_cents).toBe(CUSTO_A_CENTS);
  });

  it("a leitura é POR ORGANIZAÇÃO: o vizinho lê zero nos dois sentidos", () => {
    expect(countAs(USER_B, `select count(*) from public.llm_calls where organization_id = '${ORG_A}'`)).toBe(0);
    expect(countAs(USER_A, `select count(*) from public.llm_calls where organization_id = '${ORG_B}'`)).toBe(0);
    // E o controle positivo do outro lado, para o zero não ser falta de seed.
    expect(countAs(USER_B, `select count(*) from public.llm_calls where organization_id = '${ORG_B}'`)).toBe(1);
    // A tela de custo do vizinho também não enxerga o gasto alheio.
    const usoB = JSON.parse(asUser(USER_B, consultaDoCusto(ORG_A))) as {
      totais: { chamadas: number; custo_cents: number };
    };
    expect(usoB.totais.chamadas).toBe(0);
    expect(usoB.totais.custo_cents).toBe(0);
  });

  it("reconstruído o estado da instalação (sem policy permissiva), o membro lê 0 e o service role lê as MESMAS linhas; a 9362 devolve a leitura", () => {
    // ── o estado da instalação do membro: RLS ligada, só as restritivas ──────
    // Derruba a policy permissiva das três, como o banco do membro está. A
    // restritiva de INSERT continua de pé (é ela que deixa o worker gravar).
    sql(`
      drop policy if exists tenant_isolation_llm_calls_all on public.llm_calls;
      drop policy if exists tenant_isolation_llm_calls_select on public.llm_calls;
      drop policy if exists tenant_isolation_before_send_traces_all on public.before_send_traces;
      drop policy if exists tenant_isolation_before_send_traces_select on public.before_send_traces;
      drop policy if exists tenant_isolation_flywheel_judge_verdicts_all on public.flywheel_judge_verdicts;
      drop policy if exists tenant_isolation_flywheel_judge_verdicts_select on public.flywheel_judge_verdicts;
    `);

    // Vazio para quem usa a tela…
    expect(countAs(USER_A, `select count(*) from public.llm_calls where organization_id = '${ORG_A}'`)).toBe(0);
    const semPolicy = JSON.parse(asUser(USER_A, consultaDoCusto(ORG_A))) as {
      totais: { chamadas: number; custo_cents: number };
    };
    expect(semPolicy.totais.chamadas).toBe(0);
    expect(semPolicy.totais.custo_cents).toBe(0);

    // …e as MESMAS linhas para quem não passa por RLS. É o discriminador que
    // separa "não há dado" de "não há permissão": o número do service role é o
    // que a tela deveria mostrar.
    expect(sql(`select count(*)::text from public.llm_calls where organization_id = '${ORG_A}'`)).toBe("2");

    // ── o conserto: a migration, aplicada como o `update.sh` faria ───────────
    const migration = readFileSync(MIGRATION, "utf8");
    sql(migration);

    expect(countAs(USER_A, `select count(*) from public.llm_calls where organization_id = '${ORG_A}'`)).toBe(2);
    expect(countAs(USER_B, `select count(*) from public.llm_calls where organization_id = '${ORG_A}'`)).toBe(0);
    const comPolicy = JSON.parse(asUser(USER_A, consultaDoCusto(ORG_A))) as {
      totais: { chamadas: number; custo_cents: number };
    };
    expect(comPolicy.totais.chamadas).toBe(2);
    expect(comPolicy.totais.custo_cents).toBe(CUSTO_A_CENTS);

    // ── e é IDEMPOTENTE: banco que já tem a policy parcial reaplica sem erro ──
    expect(() => sql(migration)).not.toThrow();
    expect(countAs(USER_A, `select count(*) from public.llm_calls where organization_id = '${ORG_A}'`)).toBe(2);
  });

  it("reaplicar o `baseline.sql` (o caminho do `update.sh`) recria a policy — a varredura da 0325 não cura sozinha", () => {
    // Este é o caso que REPROVA sem o conserto, e é o que o membro vive: a
    // instalação já tem RLS ligada, então `fn_proteger_tabelas_de_organizacao()`
    // pula as três tabelas (`and not c.relrowsecurity`) e
    // `fn_aplicar_travas_de_suporte()` só repõe as restritivas de escrita. Sem o
    // bloco da 9362 no baseline, reaplicar o arquivo INTEIRO deixa a leitura em
    // zero — que é o "o update.sh não recria" da issue.
    sql(`
      drop policy if exists tenant_isolation_llm_calls_select on public.llm_calls;
      drop policy if exists tenant_isolation_before_send_traces_select on public.before_send_traces;
      drop policy if exists tenant_isolation_flywheel_judge_verdicts_select on public.flywheel_judge_verdicts;
      drop policy if exists tenant_isolation_llm_calls_all on public.llm_calls;
      drop policy if exists tenant_isolation_before_send_traces_all on public.before_send_traces;
      drop policy if exists tenant_isolation_flywheel_judge_verdicts_all on public.flywheel_judge_verdicts;
    `);
    expect(countAs(USER_A, `select count(*) from public.llm_calls where organization_id = '${ORG_A}'`)).toBe(0);

    sql(readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8"));

    expect(countAs(USER_A, `select count(*) from public.llm_calls where organization_id = '${ORG_A}'`)).toBe(2);
    expect(countAs(USER_B, `select count(*) from public.llm_calls where organization_id = '${ORG_A}'`)).toBe(0);
    const depoisDoUpdate = JSON.parse(asUser(USER_A, consultaDoCusto(ORG_A))) as {
      totais: { chamadas: number; custo_cents: number };
    };
    expect(depoisDoUpdate.totais.chamadas).toBe(2);
    expect(depoisDoUpdate.totais.custo_cents).toBe(CUSTO_A_CENTS);
  }, 300_000);
});
