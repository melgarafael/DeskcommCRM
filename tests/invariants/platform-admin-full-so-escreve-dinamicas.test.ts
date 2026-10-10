/**
 * 0533 — as 9 policies DINÂMICAS da #2115 que a lista de 47 não via.
 *
 * Os laços `format()` de 0350 (`financial_accounts`, `payment_methods`,
 * `account_plans`; with check manager) e 0351 (`sales`, `sale_items`,
 * `commission_rules`, `commissions`, `financial_entries`, `loyalty_ledger`;
 * with check agent) criavam `tenant_isolation_%I_all` com
 * `fn_is_platform_admin()`, que ignora o scope do JWT: `support_readonly`
 * escrevia em dinheiro. A conta global de `platform-admin-full-so-escreve`
 * achou as 9. Viraram o par de `recurring_entries`: `_read` com a pura,
 * `_write` com `_full`.
 *
 * Mede em Postgres REAL:
 *   · CATÁLOGO: `_write` com `_full` e sem a pura; `_read` mantém a pura;
 *     o `_all` não existe mais;
 *   · COMPORTAMENTO em `financial_accounts`: `support_readonly` lê, faz UPDATE
 *     em 0 linhas; `full` faz em 1 (controle positivo).
 *
 * Previsão escrita antes de rodar (sabotagem): devolvida a pura ao `_write` de
 * um dos laços, o catálogo acusa as tabelas dele; no laço de 0350, a sonda
 * devolve 1 em vez de 0.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { countAs, seedGov, sql, writeCountAs } from "./gov-helpers";

const ORG = "cccccccc-2115-4000-8000-000000000301";
const FULL = "cccccccc-2115-4000-8000-000000000310";
const READONLY = "cccccccc-2115-4000-8000-000000000311";
const CONTA = "cccccccc-2115-4000-8000-000000000302";

const DINAMICAS = [
  "financial_accounts",
  "payment_methods",
  "account_plans",
  "sales",
  "sale_items",
  "commission_rules",
  "commissions",
  "financial_entries",
  "loyalty_ledger",
] as const;

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

beforeAll(() => {
  // #1907 — o módulo financeiro INSTALADO antes de medir: as cinco tabelas da comanda
  // (`sales`, `sale_items`, `commission_rules`, `commissions`, `loyalty_ledger`) saíram do
  // `baseline.sql` e as policies dinâmicas de 0351 nascem em `fn_financeiro_provisionar()`
  // (ADR-0002 D2/D3) — sem a chamada, `expressaoViva` não acha
  // `tenant_isolation_sales_write` e este arquivo inteiro cai por um banco sem o módulo.
  sql("select public.fn_financeiro_provisionar();");
  seedGov();
  sql(`
    delete from public.financial_accounts where organization_id = '${ORG}';
    delete from public.organizations where id = '${ORG}';
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG}', 'org-2115-din', 'Org 2115 dinâmicas', 'Org 2115 dinâmicas');
    insert into auth.users (id, email) values
      ('${FULL}', 'full-2115-din@invariant.test'),
      ('${READONLY}', 'readonly-2115-din@invariant.test')
    on conflict (id) do nothing;
    delete from public.platform_admins where user_id in ('${FULL}', '${READONLY}');
    insert into public.platform_admins (user_id, granted_by, scope, mfa_required, reason) values
      ('${FULL}', '${FULL}', 'full', false, 'invariante 2115 dinâmicas'),
      ('${READONLY}', '${FULL}', 'support_readonly', false, 'invariante 2115 dinâmicas');
    insert into public.financial_accounts (id, organization_id, name)
      values ('${CONTA}', '${ORG}', 'Conta 2115 dinâmicas');
  `);
});

describe("0533 — support_readonly não escreve nas 9 dinâmicas de 0350/0351", () => {
  it("catálogo: _write com _full, _read com a pura, sem _all", () => {
    const faltando: string[] = [];
    for (const tabela of DINAMICAS) {
      const escrita = expressaoViva(tabela, `tenant_isolation_${tabela}_write`);
      if (!escrita.includes("fn_is_platform_admin_full")) faltando.push(`${tabela}_write: sem _full`);
      if (/fn_is_platform_admin\s*\(/.test(escrita)) faltando.push(`${tabela}_write: ainda aceita a pura`);
      const leitura = expressaoViva(tabela, `tenant_isolation_${tabela}_read`);
      if (!/fn_is_platform_admin\s*\(/.test(leitura)) faltando.push(`${tabela}_read: perdeu a pura`);
      const sobra = sql(
        `select count(*) from pg_policies where schemaname = 'public' and tablename = '${tabela}' and policyname = 'tenant_isolation_${tabela}_all';`,
      );
      if (sobra !== "0") faltando.push(`${tabela}: _all ainda existe`);
    }
    expect(faltando, "dinâmica de 0350/0351 fora do par da 0533").toEqual([]);
  });

  it("financial_accounts: support_readonly LÊ; UPDATE 0 como support_readonly; 1 como full", () => {
    expect(countAs(READONLY, `select count(*) from public.financial_accounts where id = '${CONTA}';`)).toBe(1);
    expect(writeCountAs(READONLY, `update public.financial_accounts set name = 'hackeado' where id = '${CONTA}'`)).toBe(0);
    expect(writeCountAs(FULL, `update public.financial_accounts set name = 'escrito pelo full' where id = '${CONTA}'`)).toBe(1);
  });
});
