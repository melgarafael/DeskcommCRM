import { spawn } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";

import { countAs, sql } from "./gov-helpers";

/**
 * O VALOR DO NEGÓCIO SEGUE AS VENDAS REGISTRADAS (#5087, migrations 9449/9450).
 *
 * Medido no banco real que o self-host aplica (baseline.sql):
 *  1. soma: com vendas, `crm_leads.value_cents` é a soma delas;
 *  2. corrida: duas vendas em transações simultâneas no MESMO negócio entram
 *     as duas na soma (o gatilho trava a linha do negócio antes de somar);
 *  3. 2B (doc 396): o valor digitado fica guardado e VOLTA quando a última
 *     venda é apagada;
 *  4. moeda: negócio em USD numa empresa BRL soma as vendas em USD;
 *  5. isolamento: a sessão de uma empresa não lê as vendas da outra;
 *  6. LGPD: anonimizar o contato zera observação e tags, e o valor fica.
 */

const ORG = "50870000-0000-4000-8000-000000000001";
const OUTRA_ORG = "50870000-0000-4000-8000-000000000002";
const USUARIO = "50870000-1111-4000-8000-000000000001";
const VIZINHO = "50870000-1111-4000-8000-000000000002";
const FUNIL = "50870000-2222-4000-8000-000000000001";
const ETAPA = "50870000-3333-4000-8000-000000000001";
const CONTATO = "50870000-4444-4000-8000-000000000001";
const LEAD_SOMA = "50870000-5555-4000-8000-000000000001";
const LEAD_CORRIDA = "50870000-5555-4000-8000-000000000002";
const LEAD_2B = "50870000-5555-4000-8000-000000000003";
const LEAD_USD = "50870000-5555-4000-8000-000000000004";

const valor = (lead: string) => sql(`select coalesce(value_cents::text, 'null') from crm_leads where id = '${lead}'`);
const vender = (lead: string, cents: number, moeda = "BRL") =>
  `insert into vendas_registradas (organization_id, lead_id, contact_id, valor_cents, currency, data)
   values ('${ORG}', '${lead}', '${CONTATO}', ${cents}, '${moeda}', current_date);`;

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${USUARIO}', 'vendas-5087@invariant.test'),
      ('${VIZINHO}', 'vendas-5087-b@invariant.test');
    insert into organizations (id, slug, legal_name, display_name, currency) values
      ('${ORG}', 'vendas-5087', 'Vendas sintética', 'Vendas sintética', 'BRL'),
      ('${OUTRA_ORG}', 'vendas-5087-b', 'Vizinha sintética', 'Vizinha sintética', 'BRL');
    insert into user_organizations (organization_id, user_id, role, accepted_at) values
      ('${ORG}', '${USUARIO}', 'agent', now()),
      ('${OUTRA_ORG}', '${VIZINHO}', 'agent', now());
    insert into crm_pipelines (id, organization_id, name, slug) values ('${FUNIL}', '${ORG}', 'Funil', 'funil-5087');
    insert into crm_stages (id, organization_id, pipeline_id, name, slug, position)
      values ('${ETAPA}', '${ORG}', '${FUNIL}', 'Entrada', 'entrada', 1);
    insert into contacts (id, organization_id, name) values ('${CONTATO}', '${ORG}', 'Cliente sintético');
    insert into crm_leads (id, organization_id, pipeline_id, stage_id, title, contact_id, value_cents, currency) values
      ('${LEAD_SOMA}', '${ORG}', '${FUNIL}', '${ETAPA}', 'Soma', '${CONTATO}', null, null),
      ('${LEAD_CORRIDA}', '${ORG}', '${FUNIL}', '${ETAPA}', 'Corrida', '${CONTATO}', null, null),
      ('${LEAD_2B}', '${ORG}', '${FUNIL}', '${ETAPA}', 'Digitado', '${CONTATO}', 50000, null),
      ('${LEAD_USD}', '${ORG}', '${FUNIL}', '${ETAPA}', 'Em dólar', '${CONTATO}', null, 'USD');
  `);
});

describe("#5087 — o Valor do negócio pelas vendas registradas", () => {
  it("soma: duas vendas, o Valor é a soma", () => {
    sql(vender(LEAD_SOMA, 18000) + vender(LEAD_SOMA, 12000));
    expect(valor(LEAD_SOMA)).toBe("30000");
  });

  it("corrida: duas vendas em transações simultâneas entram as duas na soma", async () => {
    const container = process.env.TEST_DB_CONTAINER;
    if (!container) throw new Error("rode via pnpm test:db");
    const abrir = () =>
      spawn("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres", "-qAt", "-v", "ON_ERROR_STOP=1", "-f", "-"]);
    const acompanhar = (p: ReturnType<typeof abrir>) => {
      let saida = "";
      let erro = "";
      p.stdout.on("data", (s) => (saida += s.toString()));
      p.stderr.on("data", (s) => (erro += s.toString()));
      const fim = new Promise<string>((resolve, reject) => {
        p.once("error", reject);
        p.once("close", (code) => (code === 0 ? resolve(saida.trim()) : reject(new Error(`psql ${code}: ${erro}`))));
      });
      void fim.catch(() => {});
      return { fim, saida: () => saida };
    };
    const a = abrir();
    const um = acompanhar(a);
    const b = abrir();
    const dois = acompanhar(b);
    try {
      a.stdin.write(`begin; ${vender(LEAD_CORRIDA, 10000)}\n\\echo PRIMEIRA_DENTRO\n`);
      await expect.poll(um.saida, { timeout: 10_000, interval: 50 }).toContain("PRIMEIRA_DENTRO");
      b.stdin.end(`set application_name='vendas-5087-corrida'; begin; ${vender(LEAD_CORRIDA, 7000)} commit;\n`);
      // A segunda espera a trava do negócio: é ali que, sem ela, a soma sairia sem a primeira.
      await expect
        .poll(
          () => sql("select count(*) from pg_stat_activity where application_name='vendas-5087-corrida' and wait_event_type='Lock'"),
          { timeout: 10_000, interval: 50 },
        )
        .toBe("1");
      a.stdin.end("commit;\n");
      await Promise.all([um.fim, dois.fim]);
      expect(valor(LEAD_CORRIDA)).toBe("17000");
    } finally {
      if (!a.stdin.writableEnded) a.stdin.end("rollback;\n");
      if (!b.stdin.writableEnded) b.stdin.end();
      await Promise.allSettled([um.fim, dois.fim]);
    }
  });

  it("2B: o valor digitado fica guardado e volta quando a última venda sai", () => {
    sql(vender(LEAD_2B, 10000));
    expect(valor(LEAD_2B)).toBe("10000");
    expect(sql(`select valor_pelas_vendas, valor_digitado_cents from crm_leads where id = '${LEAD_2B}'`)).toBe("t|50000");

    sql(`delete from vendas_registradas where lead_id = '${LEAD_2B}'`);
    expect(valor(LEAD_2B)).toBe("50000");
    expect(sql(`select valor_pelas_vendas, coalesce(valor_digitado_cents::text, 'null') from crm_leads where id = '${LEAD_2B}'`)).toBe(
      "f|null",
    );
  });

  it("moeda: negócio em USD numa empresa BRL soma as vendas em USD", () => {
    sql(vender(LEAD_USD, 5000, "USD"));
    expect(valor(LEAD_USD)).toBe("5000");
  });

  it("isolamento: a sessão da empresa vizinha não lê as vendas desta", () => {
    const daEmpresa = `select count(*) from vendas_registradas where organization_id = '${ORG}';`;
    expect(countAs(USUARIO, daEmpresa)).toBeGreaterThan(0); // controle positivo
    expect(countAs(VIZINHO, daEmpresa)).toBe(0);
  });

  it("LGPD: anonimizar o contato zera observação e tags, e o valor fica", () => {
    sql(`update vendas_registradas set observacao = 'Prefere entrega à tarde', tags = '{atacado}' where lead_id = '${LEAD_SOMA}';
         update contacts set is_anonymized = true, anonymized_at = now() where id = '${CONTATO}';`);
    expect(
      sql(`select count(*) filter (where observacao is not null or tags <> '{}'), sum(valor_cents)
             from vendas_registradas where lead_id = '${LEAD_SOMA}'`),
    ).toBe("0|30000");
  });
});
