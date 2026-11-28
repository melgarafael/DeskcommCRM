import { execFileSync } from "node:child_process";

import { beforeAll, describe, expect, it } from "vitest";

import { RAIZES_DO_APAGAMENTO } from "@/lib/settings/apagar-dados-operacionais";

/**
 * "LIMPAR DADOS DE TESTE" LEVA EMPRESAS, PESSOAS E IMPORTAÇÕES (A22, #4887).
 *
 * O reset (`apagarDadosOperacionaisDaOrg`) é um DELETE por raiz, na ordem de
 * `RAIZES_DO_APAGAMENTO`, sempre com `organization_id`. Para as três raízes novas
 * (`import_batches`, `people`, `companies`) a promessa é a de que, DEPOIS de
 * `contacts`, a ordem é livre e nenhuma FK recusa — `company_people` e
 * `import_rows` caem em CASCADE, e `contacts.person_id` / `contacts.company_id` e
 * `import_rows.company_id/person_id` viram NULL.
 *
 * Este arquivo roda a MESMA lista, na MESMA ordem, contra o Postgres do baseline:
 * se alguém acrescentar uma FK RESTRICT para `people` ou `companies`, o reset
 * passa a parar no meio com 23503 e este teste reprova antes de a tela mentir.
 * O controle é a organização vizinha, que não pode perder uma linha.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db`");
const containerName: string = container;

function sql(script: string): string {
  return execFileSync(
    "docker",
    ["exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"],
    { input: script, encoding: "utf8" },
  ).trim();
}

const ORG = "48870000-0000-4000-8000-000000000001";
const VIZINHA = "48870000-0000-4000-8000-000000000002";

function semear(org: string, tag: string): void {
  const id = (n: string) => `48870000-${n}-4000-8000-0000000000${tag}`;
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${org}', 'limpar-${tag}', 'Limpar ${tag}', 'Limpar ${tag}')
      on conflict (id) do nothing;
    insert into public.companies (id, organization_id, legal_name)
      values ('${id("1111")}', '${org}', 'Empresa ${tag}') on conflict (id) do nothing;
    insert into public.people (id, organization_id, full_name)
      values ('${id("2222")}', '${org}', 'Pessoa ${tag}') on conflict (id) do nothing;
    insert into public.company_people (organization_id, company_id, person_id)
      values ('${org}', '${id("1111")}', '${id("2222")}') on conflict do nothing;
    -- O contato aponta para a pessoa e para a empresa (SET NULL) e sai antes delas.
    insert into public.contacts (id, organization_id, display_name, person_id, company_id)
      values ('${id("3333")}', '${org}', 'Contato ${tag}', '${id("2222")}', '${id("1111")}')
      on conflict (id) do nothing;
    insert into public.import_batches (id, organization_id, filename)
      values ('${id("4444")}', '${org}', 'teste-${tag}.csv') on conflict (id) do nothing;
    insert into public.import_rows (organization_id, batch_id, row_number, company_id, person_id, contact_id)
      values ('${org}', '${id("4444")}', 1, '${id("1111")}', '${id("2222")}', '${id("3333")}')
      on conflict do nothing;
  `);
}

function contar(tabela: string, org: string): number {
  return Number(sql(`select count(*) from public.${tabela} where organization_id = '${org}';`));
}

const TABELAS_DO_MODULO = ["companies", "people", "company_people", "import_batches", "import_rows", "contacts"];

describe("limpar dados de teste: empresas, pessoas e importações saem, a vizinha fica", () => {
  beforeAll(() => {
    semear(ORG, "01");
    semear(VIZINHA, "02");
  });

  it("controle positivo: a semente existe nas duas organizações antes do reset", () => {
    for (const tabela of TABELAS_DO_MODULO) {
      expect(contar(tabela, ORG), `${tabela} da organização`).toBe(1);
      expect(contar(tabela, VIZINHA), `${tabela} da vizinha`).toBe(1);
    }
  });

  it("o DELETE por raiz, na ordem declarada, passa sem violar FK e zera a organização", () => {
    const script = RAIZES_DO_APAGAMENTO.map(
      ({ tabela }) => `delete from public.${tabela} where organization_id = '${ORG}';`,
    ).join("\n");
    // ON_ERROR_STOP=1: uma FK RESTRICT nova (23503) derruba o script inteiro.
    sql(script);

    for (const tabela of TABELAS_DO_MODULO) {
      expect(contar(tabela, ORG), `${tabela} sobrou depois do reset`).toBe(0);
    }
  });

  it("a organização VIZINHA continua inteira, linha por linha", () => {
    for (const tabela of TABELAS_DO_MODULO) {
      expect(contar(tabela, VIZINHA), `${tabela} da vizinha foi tocada`).toBe(1);
    }
  });

  it("a configuração não é raiz: a própria organização continua de pé", () => {
    expect(Number(sql(`select count(*) from public.organizations where id = '${ORG}';`))).toBe(1);
  });
});
