import { beforeAll, describe, expect, it } from "vitest";

import {
  AVISO_CORPO,
  AVISO_TITULO,
  SQL_ORCAMENTO,
  SQL_TETO_DO_PLANO,
} from "@/lib/agent-engine/edge/llm/orcamento";

import { sql } from "./psql-transporte";

/**
 * O TETO DE IA DO PLANO CONTRA O POSTGRES DE VERDADE (spec cobrança §5).
 *
 * O gate do engine lê o teto por `SQL_TETO_DO_PLANO` pelo pool `pg`, e o dublê
 * dos testes unitários devolve a linha que o teste quiser. Um erro de SQL aqui
 * vira "teto indisponível": a chamada SEGUE, sem teto, em silêncio — o dublê
 * nunca veria. Só o Postgres real diz se o statement roda.
 *
 * E a retratação: a CTE `retrata` de `SQL_ORCAMENTO` roda a cada chamada com
 * orçamento ligado e fechava TODO `budget_exceeded` aberto. Sem o filtro de
 * `ref_kind`, ela fecharia o item do PLANO na chamada seguinte de uma org que
 * também usa chave própria. O item legado sem `ref_kind` (gravado antes de o
 * insert ter referência) continua sendo fechado por ela.
 */
const ORG = "c0de0510-7e70-4000-8000-0000000000a1"; // assinatura com plano de teto 1000
const ORG_B = "c0de0510-7e70-4000-8000-0000000000b2"; // sem ai_budgets: a retrata do orçamento dispara
const PLANO = "c0de0510-7e70-4000-8000-0000000000c3";

function rodarTeto(org: string): { teto: string; gasto: string } {
  const [teto = "", gasto = ""] = sql(
    SQL_TETO_DO_PLANO.replace(/\$1/g, `'${org}'::uuid`).replace(/\$2/g, `'ia_usd_cents'`),
  ).split("|");
  return { teto, gasto };
}

function rodarOrcamento(org: string): void {
  sql(
    SQL_ORCAMENTO.replace(/\$1/g, `'${org}'::uuid`)
      .replace(/\$2/g, `'${AVISO_TITULO}'`)
      .replace(/\$3/g, `'${AVISO_CORPO}'`),
  );
}

function ligarCobranca(ligada: boolean): void {
  sql(
    ligada
      ? `insert into public.platform_config (chave, valor) values ('MODULO_COBRANCA', 'ligado')
           on conflict (chave) do update set valor = excluded.valor;`
      : `delete from public.platform_config where chave = 'MODULO_COBRANCA';`,
  );
}

function gastar(org: string, cents: number): void {
  sql(`insert into public.llm_calls
         (organization_id, purpose, provider, model, input_tokens, output_tokens, cost_cents, latency_ms)
       values ('${org}', 'agent_turn', 'anthropic', 'claude-sonnet-4', 10, 10, ${cents}, 100);`);
}

function abrirItem(org: string, refKind: string | null): void {
  sql(`insert into public.agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id)
       values ('${org}', 'budget_exceeded', 'critical', 'titulo', 'corpo',
               ${refKind === null ? "null" : `'${refKind}'`}, ${refKind === null ? "null" : `'${org}'`});`);
}

function abertos(org: string, refKind: string | null): number {
  return Number(
    sql(`select count(*) from public.agent_inbox_items
          where organization_id = '${org}' and kind = 'budget_exceeded' and status = 'open'
            and ref_kind ${refKind === null ? "is null" : `= '${refKind}'`};`),
  );
}

describe("o teto de IA do plano no Postgres real", () => {
  beforeAll(() => {
    sql(`
      insert into public.organizations (id, slug, legal_name, display_name, settings) values
        ('${ORG}', 'inv-teto-plano', 'Teto LTDA', 'Teto', '{}'::jsonb),
        ('${ORG_B}', 'inv-teto-plano-b', 'Teto B LTDA', 'Teto B', '{}'::jsonb);
      insert into public.cobranca_planos (id, nome, preco_cents, intervalo, teto_ia_usd_cents)
        values ('${PLANO}', 'Básico', 9900, 'mes', 1000);
      insert into public.cobranca_assinaturas (organization_id, plano_id, estado, trial_ate)
        values ('${ORG}', '${PLANO}', 'trial', now() + interval '14 days');
    `);
  });

  it("⭐ cobrança DESLIGADA: sem teto e sem gasto — a instalação de empresa única não paga a soma", () => {
    ligarCobranca(false);
    expect(rodarTeto(ORG)).toEqual({ teto: "", gasto: "" });
  });

  it("cobrança ligada: o teto do plano e o gasto da régua única, e o item do plano se fecha abaixo do teto", () => {
    ligarCobranca(true);
    gastar(ORG, 500);
    abrirItem(ORG, "plano");
    const { teto, gasto } = rodarTeto(ORG);
    expect(Number(teto)).toBe(1000);
    expect(Number(gasto)).toBe(500);
    expect(abertos(ORG, "plano"), "o laço de retorno não fechou o aviso do plano").toBe(0);
  });

  it("gasto no teto: o item do plano FICA aberto", () => {
    ligarCobranca(true);
    gastar(ORG, 1000);
    abrirItem(ORG, "plano");
    expect(Number(rodarTeto(ORG).gasto)).toBe(1500);
    expect(abertos(ORG, "plano")).toBe(1);
  });

  // LAÇO DE RETORNO quando o teto SOME: a empresa ficou isenta (DELETE da
  // assinatura) ou o plano perdeu o teto. O gate devolve 'sem_teto' e a IA volta
  // a responder; o aviso "As conversas foram para a equipe" não pode ficar aceso
  // afirmando uma parada que não existe mais — a régua do SQL_ORCAMENTO.
  it("⭐ empresa sem teto (isenta): o item do plano fecha na chamada seguinte", () => {
    ligarCobranca(true);
    abrirItem(ORG_B, "plano");
    expect(rodarTeto(ORG_B)).toEqual({ teto: "", gasto: "" });
    expect(abertos(ORG_B, "plano"), "o aviso do plano ficou aceso depois de o teto sumir").toBe(0);
  });

  it("⭐ desligar a cobrança fecha o aviso do plano de TODA empresa", () => {
    // Com a cobrança desligada o gate nem lê o teto (memo de módulos), então
    // quem fecha é o ato de desligar: fn_cobranca_liberar_suspensoes, a mesma
    // função que solta as empresas suspensas por cobrança.
    ligarCobranca(true);
    // O caso "gasto no teto" acima deixa o item de ORG aberto (um por org, 0583 G).
    if (abertos(ORG, "plano") === 0) abrirItem(ORG, "plano");
    abrirItem(ORG_B, "plano");
    expect(abertos(ORG, "plano") + abertos(ORG_B, "plano")).toBe(2);
    sql(`select public.fn_cobranca_liberar_suspensoes(null);`);
    expect(abertos(ORG, "plano"), "desligar a cobrança deixou o aviso do plano aceso").toBe(0);
    expect(abertos(ORG_B, "plano"), "desligar a cobrança deixou o aviso do plano aceso").toBe(0);
  });

  it("⭐ a retrata do orçamento da org fecha o item dela e o legado, NUNCA o do plano", () => {
    // O item do orçamento e o legado sem ref_kind são a MESMA família no
    // índice da 0540 (um aberto por org; o do plano tem o seu, 0583 seção G):
    // os dois não ficam abertos juntos, então cada um é medido numa rodada.
    abrirItem(ORG_B, "plano");
    abrirItem(ORG_B, null);
    rodarOrcamento(ORG_B);
    expect(abertos(ORG_B, null), "o item legado sem ref_kind ficou preso aberto").toBe(0);
    expect(abertos(ORG_B, "plano"), "o orçamento da org fechou o aviso do PLANO").toBe(1);
    abrirItem(ORG_B, "ai_budget");
    rodarOrcamento(ORG_B);
    expect(abertos(ORG_B, "plano"), "o orçamento da org fechou o aviso do PLANO").toBe(1);
    expect(abertos(ORG_B, "ai_budget")).toBe(0);
  });
});
