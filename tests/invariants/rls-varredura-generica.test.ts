import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/**
 * Achado ao comparar com o changelog do upstream (DeskcommCRM 1.10.0): "uma
 * tabela nova que seja criada sem RLS passa a ser recusada automaticamente
 * antes de virar uma atualização que chega ao cliente self-host".
 *
 * O SonghaiCRM não tinha esse mecanismo — só cobertura MANUAL, tabela por
 * tabela: `tests/invariants/rls-isolation.test.ts` documenta a si mesmo como
 * ⚠️ LISTA FIXA ("tabela tenant-aware nova que NÃO entrar aqui passa verde sem
 * RLS"), e outros 7 arquivos cobrem uma tabela cada (`camadas-de-seguranca-
 * schema`, `meta-templates-rls`, etc.). Nenhum dos dois mecanismos é uma
 * VARREDURA — ambos dependem de alguém lembrar de escrever o teste no mesmo
 * commit da migration.
 *
 * Este teste fecha esse gap específico (RLS DESLIGADA), sem substituir os
 * testes comportamentais existentes: uma policy sabotada (`... or true`) passa
 * tanto aqui quanto na checagem de catálogo pura — só o teste comportamental
 * (que planta linhas de 2 orgs e mede vazamento de verdade) pega isso. Ver o
 * aviso equivalente em `rls-isolation.test.ts`.
 *
 * Roda contra o Postgres efêmero de `pnpm test:db` (baseline.sql já aplicado).
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error(
    "TEST_DB_CONTAINER not set — run this suite via `pnpm test:db` (scripts/test-db.sh)",
  );
}
const containerName: string = container;

function sql(script: string): string {
  return execFileSync(
    "docker",
    ["exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"],
    { input: script, encoding: "utf8" },
  ).trim();
}

describe("varredura genérica de RLS — toda tabela com organization_id tem RLS ligada", () => {
  it("nenhuma tabela tenant-aware do schema public está com relrowsecurity=false", () => {
    const out = sql(`
      select c.relname
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and c.relkind = 'r'
         and c.relrowsecurity = false
         and exists (
           select 1
             from information_schema.columns col
            where col.table_schema = 'public'
              and col.table_name = c.relname
              and col.column_name = 'organization_id'
         )
       order by c.relname;
    `);
    const infratoras = out.length > 0 ? out.split("\n").filter(Boolean) : [];
    expect(
      infratoras,
      `tabela(s) com 'organization_id' e RLS DESLIGADA — cada uma vaza dado entre organizações ` +
        `para qualquer client autenticado (PostgREST expõe toda tabela public por padrão): ` +
        `${JSON.stringify(infratoras)}. Rode 'alter table <tabela> enable row level security;' ` +
        `e adicione a policy de isolamento antes de mergear.`,
    ).toEqual([]);
  });

  it("controle do instrumento: uma tabela sem organization_id não entra na varredura", () => {
    // Sem isto, uma regex/join que parasse de casar devolveria lista vazia
    // trivialmente e o teste acima passaria à toa, medindo nada.
    const out = sql(`
      select exists (
        select 1 from information_schema.columns
         where table_schema = 'public' and table_name = 'organizations' and column_name = 'organization_id'
      );
    `);
    expect(out).toBe("f");
  });

  it("controle do instrumento: pelo menos uma tabela com organization_id existe e tem RLS ligada", () => {
    // Prova que a query principal enxerga o schema de verdade (não roda contra
    // um banco vazio/errado, o que também devolveria [] e passaria à toa).
    const out = sql(`
      select count(*)
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and c.relkind = 'r'
         and c.relrowsecurity = true
         and exists (
           select 1 from information_schema.columns col
            where col.table_schema = 'public'
              and col.table_name = c.relname
              and col.column_name = 'organization_id'
         );
    `);
    expect(Number(out)).toBeGreaterThan(10);
  });
});
