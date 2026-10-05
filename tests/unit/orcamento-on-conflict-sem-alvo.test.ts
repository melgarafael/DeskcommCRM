/**
 * O `on conflict` DO ORÇAMENTO NÃO VOLTA A DEPENDER DO ÍNDICE EXISTIR.
 *
 * A forma com alvo (`on conflict (organization_id, kind) where ...`) só resolve
 * com o índice único parcial da 0540 de pé: num clone cuja atualização aplicou
 * o código antes do banco, a consulta do orçamento falharia com 42P10 e a
 * chamada seguiria SEM TETO (o `catch` de leitura é fail-open de propósito,
 * para erro de banco não derrubar o cliente). A forma sem alvo não infere nada,
 * e para estas linhas (kind de orçamento) o único conflito possível é o do
 * índice da 0540.
 *
 * O caso `(j0)` de `tests/invariants/orcamento-nasce-desarmado.test.ts` mede o
 * COMPORTAMENTO do statement sem o índice; aqui se prende a FORMA dos dois
 * inserts — o do `budget_exceeded` não é executado por nenhum outro teste.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SQL_ORCAMENTO } from "@/lib/agent-engine/edge/llm/orcamento";

describe("o on conflict do orçamento não depende de inferência de índice", () => {
  it("o statement do orçamento usa a forma sem alvo", () => {
    expect(SQL_ORCAMENTO).toContain("on conflict do nothing");
    expect(
      SQL_ORCAMENTO,
      "a forma com alvo exige que o índice da 0540 exista (42P10 → segue sem teto)",
    ).not.toMatch(/on conflict\s*\(/i);
  });

  it("o insert do `budget_exceeded` usa a forma sem alvo", () => {
    const fonte = readFileSync(
      join(process.cwd(), "lib", "agent-engine", "edge", "llm", "run-model-call.ts"),
      "utf8",
    );
    expect(
      (fonte.match(/on conflict do nothing/g) ?? []).length,
      "esperava UM insert com a forma sem alvo — a sonda perdeu o alvo",
    ).toBe(1);
    expect(
      fonte,
      "a forma com alvo exige que o índice da 0540 exista (42P10 → a recusa vira erro de banco)",
    ).not.toMatch(/on conflict\s*\(/i);
  });
});
