/**
 * O BACKFILL 0068 NUNCA PODE GERAR DUAS LINHAS PARA O MESMO `model_id`.
 *
 * ## Por que este arquivo existe
 *
 * `ai_pricing` tem PK só em `model` (`ai_pricing_pkey`), enquanto `ai_models` é
 * único por `(provider, model_id)`. O backfill 0068 deriva `ai_pricing` de
 * `ai_models` num `insert ... select` idempotente embrulhado em `not exists`.
 * Quando o MESMO `model_id` existe sob DOIS provedores (ex.: `openrouter` e
 * `requesty`), o select devolve DUAS linhas iguais DENTRO da mesma passada — o
 * `not exists` não enxerga, porque os duplicados ainda não foram inseridos — e a
 * PK recusa com `duplicate key value violates unique constraint
 * "ai_pricing_pkey"`. Foi o bug relatado (issue): o `update.sh` para na etapa do
 * banco e o rollback `--force` falha no mesmo ponto.
 *
 * A correção é o `select distinct on (m.model_id) ... order by m.model_id,
 * m.input_price_per_million_cents asc`, que devolve UMA linha por `model_id`
 * (escolhendo deterministicamente o provedor de menor preço em caso de empate)
 * e preserva a idempotência com o `not exists` existente.
 *
 * Este teste lê o texto do `baseline.sql` e afirma que o bloco deduplica por
 * `model_id`. Ele roda na malha unitária (não exige Postgres/Docker), então pega
 * a regressão antes mesmo do `test:db` de CI; e é a CATRACA do fix: reverter o
 * bloco para `select` cru (sem `distinct on`) deixa este arquivo VERMELHO.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = process.cwd();
const BASELINE = readFileSync(join(RAIZ, "supabase", "baseline.sql"), "utf8");

/** Extrai o corpo do primeiro `insert into public.ai_pricing (model, prompt_cents...` até o `;` que o fecha. */
function blocoDoBackfillDePrecos(): string {
  const inicio = BASELINE.indexOf(
    "insert into public.ai_pricing (model, prompt_cents_per_million_tokens, completion_cents_per_million_tokens, notes)",
  );
  expect(inicio, "bloco do backfill 0068 não encontrado no baseline.sql").toBeGreaterThan(-1);
  const fim = BASELINE.indexOf(";", inicio);
  expect(fim, "bloco do backfill sem fechamento ';'").toBeGreaterThan(inicio);
  return BASELINE.slice(inicio, fim);
}

describe("o backfill 0068 deduplica por model_id", () => {
  const bloco = blocoDoBackfillDePrecos();

  it("o bloco existe e é o das strings 'backfill 0068 a partir de ai_models'", () => {
    expect(bloco).toContain("'backfill 0068 a partir de ai_models'");
  });

  it("o select usa `distinct on (m.model_id)` para UMA linha por model_id", () => {
    expect(
      bloco,
      "ai_models é único por (provider, model_id): SEM distinct on (m.model_id), o MESMO " +
        "model_id sob dois provedores gera DUAS linhas no mesmo INSERT e a PK ai_pricing_pkey " +
        "(só model) recusa — o update.sh para na etapa do banco (issue #1998).",
    ).toMatch(/select distinct on \(m\.model_id\)/);
  });

  it("o order by escolhe deterministicamente o provedor de menor preço no empate", () => {
    expect(
      bloco,
      "o `order by` precisa ter model_id primeiro (domínio do distinct on) e " +
        "input_price em segundo, para escolher o provedor mais barato em caso de empate " +
        "de forma determinística.",
    ).toMatch(/order by m\.model_id,\s*m\.input_price_per_million_cents asc\b/);
  });

  it("a idempotência do `not exists` é preservada", () => {
    expect(bloco).toContain("not exists");
    expect(bloco).toContain("p.model = m.model_id and p.superseded_at is null");
  });

  it("só existe UM bloco desses no baseline (dump + apêndice), e é o único INSERT de preço de modelo", () => {
    const ocorrencias = BASELINE.split(
      "insert into public.ai_pricing (model, prompt_cents_per_million_tokens, completion_cents_per_million_tokens, notes)",
    ).length;
    expect(ocorrencias).toBe(2); // 1 (antes) + 1 (a própria ocorrência)
  });
});