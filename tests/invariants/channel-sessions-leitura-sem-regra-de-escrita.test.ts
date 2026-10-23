import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * #3202 — a regra de ESCRITA de `channel_sessions` não pode valer para a LEITURA.
 *
 * `channel_sessions_tenant_write` era `for all`: valia também para SELECT e, combinada
 * por OR com a `channel_sessions_tenant_select`, rodava `fn_role_at_least` (→
 * `fn_user_role_in_org` → `fn_support_context`, ~4 ms) em cada linha. O embed
 * `channel_sessions` da lista da Inbox reavaliava isso por conversa: 7–10 s ou
 * `statement timeout` com ~570 conversas, ~100 ms depois da separação.
 *
 * Os dois lados que o conserto não pode mudar ficam presos aqui:
 *   1. nenhuma regra que vale para SELECT chama `fn_role_at_least` (o desempenho);
 *   2. quem lê e quem escreve continuam os mesmos: o agent da organização LÊ a
 *      conexão mas não a altera; o admin altera; a outra organização nem vê.
 *
 * Mutação conferida em 2026-10-21: recriar `channel_sessions_tenant_write` como
 * `for all` (o estado anterior) derruba o primeiro teste.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — run this suite via `pnpm test:db` (scripts/test-db.sh)");
}
const containerName: string = container;

function sql(script: string): string {
  return execFileSync(
    "docker",
    ["exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"],
    { input: script, encoding: "utf8" },
  ).trim();
}

/** Roda como `authenticated` com o JWT do usuário e devolve a ÚLTIMA linha da saída. */
function comoUsuario(userId: string, comando: string): string {
  const out = sql(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
    ${comando}
  `);
  return out.split("\n").at(-1) ?? "";
}

const ORG = "cccccccc-0000-4000-8000-000000003202";
const OUTRA = "dddddddd-0000-4000-8000-000000003202";
const ADMIN = "cccccccc-1111-4000-8000-000000003202";
const AGENTE = "cccccccc-2222-4000-8000-000000003202";
const DE_FORA = "dddddddd-1111-4000-8000-000000003202";
const SESSAO = "cccccccc-3333-4000-8000-000000003202";

beforeAll(() => {
  // Sem PII real: e-mails e nomes sintéticos (LGPD).
  sql(`
    insert into auth.users (id, email) values
      ('${ADMIN}', 'cs3202-admin@invariant.test'),
      ('${AGENTE}', 'cs3202-agente@invariant.test'),
      ('${DE_FORA}', 'cs3202-fora@invariant.test')
      on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG}', 'cs3202-org', 'CS 3202 Org', 'CS 3202'),
      ('${OUTRA}', 'cs3202-outra', 'CS 3202 Outra', 'CS 3202 Outra')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${ADMIN}', '${ORG}', 'admin', now()),
      ('${AGENTE}', '${ORG}', 'agent', now()),
      ('${DE_FORA}', '${OUTRA}', 'admin', now())
      on conflict do nothing;
    insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
      values ('${SESSAO}', '${ORG}', 'cs3202-sessao', '\\x00'::bytea)
      on conflict (id) do nothing;
  `);
});

describe("#3202 channel_sessions: a regra de escrita não roda na leitura", () => {
  it("nenhuma regra que vale para SELECT chama fn_role_at_least", () => {
    const n = sql(`
      select count(*) from pg_policy
       where polrelid = 'public.channel_sessions'::regclass
         and polcmd in ('r', '*')
         and pg_get_expr(polqual, polrelid) ~ 'fn_role_at_least';
    `);
    expect(n).toBe("0");
  });

  it("a escrita continua exigindo admin: insert, update e delete têm a regra", () => {
    const cmds = sql(`
      select string_agg(polcmd::text, '' order by polcmd::text) from pg_policy
       where polrelid = 'public.channel_sessions'::regclass
         and polname like 'channel_sessions_tenant_%'
         and coalesce(pg_get_expr(polqual, polrelid), pg_get_expr(polwithcheck, polrelid)) ~ 'fn_role_at_least\\(organization_id, ''admin''';
    `);
    expect(cmds).toBe("adw");
  });

  it("o agent da organização LÊ a conexão, mas não a altera", () => {
    expect(comoUsuario(AGENTE, `select count(*) from public.channel_sessions where id = '${SESSAO}';`)).toBe("1");
    expect(
      comoUsuario(AGENTE, `with u as (update public.channel_sessions set display_name = 'x' where id = '${SESSAO}' returning 1) select count(*) from u;`),
    ).toBe("0");
  });

  it("o admin da organização altera a conexão", () => {
    expect(
      comoUsuario(ADMIN, `with u as (update public.channel_sessions set display_name = 'cs3202' where id = '${SESSAO}' returning 1) select count(*) from u;`),
    ).toBe("1");
  });

  it("o admin de OUTRA organização nem vê a conexão", () => {
    expect(comoUsuario(DE_FORA, `select count(*) from public.channel_sessions where id = '${SESSAO}';`)).toBe("0");
  });
});
