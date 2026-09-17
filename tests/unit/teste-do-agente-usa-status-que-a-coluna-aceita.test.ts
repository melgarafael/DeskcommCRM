/**
 * A rota de teste do agente só escreve status que o CHECK de `ai_agent_runs`
 * aceita.
 *
 * O defeito que originou este arquivo: os dois UPDATEs de fechamento gravavam
 * `"ok"` e `"error"` — o vocabulário de `llm_calls`, que é OUTRA tabela. O
 * Postgres rejeitava os dois com 23514, e o `await` não olhava `error` (ao
 * contrário do INSERT logo acima, que sempre olhou). Resultado: em toda
 * instalação, toda execução da aba Teste deixava uma linha presa em `running`
 * para sempre. Medido numa VPS v1.20.0: 16 execuções, 16 linhas em `running`.
 *
 * Nada reprovava isso. Não havia erro em lugar nenhum — o defeito era mudo por
 * construção, porque a única evidência dele foi descartada no `await`.
 *
 * Este teste lê o CHECK do `supabase/baseline.sql` (o arquivo que o self-hoster
 * realmente aplica) e o código da rota, e cobra que todo status escrito esteja
 * lá. Ler o baseline em vez de repetir a lista aqui é o ponto: uma lista copiada
 * seria a quarta cópia do mesmo vocabulário, e é exatamente assim que a terceira
 * divergiu.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = join(__dirname, "..", "..");

function statusAceitosPelaColuna(): string[] {
  const baseline = readFileSync(join(RAIZ, "supabase", "baseline.sql"), "utf8");
  const linha = baseline
    .split("\n")
    .find((l) => l.includes("ai_agent_runs_status_check"));
  expect(linha, "o CHECK de ai_agent_runs sumiu do baseline").toBeTruthy();
  return [...(linha as string).matchAll(/'([a-z_]+)'::"?text"?/g)].map((m) => m[1]!);
}

function statusEscritosPelaRota(): string[] {
  const rota = readFileSync(
    join(RAIZ, "app", "api", "v1", "ai", "agents", "[id]", "versions", "[vid]", "test", "route.ts"),
    "utf8",
  );
  // `status: "x"` em objeto de escrita. O `status` do payload de RESPOSTA (que é
  // outro vocabulário, da API, e legitimamente usa "ok"/"blocked") fica de fora
  // porque é montado com template/ternário, não com literal direto.
  return [...rota.matchAll(/status:\s*"([a-z_]+)"/g)].map((m) => m[1]!);
}

describe("status do run de teste", () => {
  it("o CHECK do baseline é legível e não está vazio", () => {
    const aceitos = statusAceitosPelaColuna();
    expect(aceitos).toContain("running");
    expect(aceitos).toContain("completed");
    expect(aceitos).toContain("failed");
  });

  it("todo status que a rota grava é aceito pela coluna", () => {
    const aceitos = statusAceitosPelaColuna();
    const escritos = statusEscritosPelaRota();

    expect(escritos.length, "nenhum status literal encontrado na rota").toBeGreaterThan(0);
    for (const s of escritos) {
      expect(aceitos, `a rota grava "${s}", que o CHECK de ai_agent_runs recusa`).toContain(s);
    }
  });

  it("o vocabulário de llm_calls NÃO vaza para cá", () => {
    // "ok"/"erro" são de `llm_calls`. Foi exatamente essa confusão.
    const escritos = statusEscritosPelaRota();
    expect(escritos).not.toContain("ok");
    expect(escritos).not.toContain("erro");
    expect(escritos).not.toContain("error");
  });
});
