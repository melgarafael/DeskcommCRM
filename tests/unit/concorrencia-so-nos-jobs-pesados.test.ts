/**
 * O cancelamento da rodada superada vive em cada job PESADO, nunca no workflow
 * nem no agregador. Medido em 18/09/2026 (#1190): com `concurrency:` no nível de
 * workflow, o agregador de `if: always()` da rodada CANCELADA ficou na fila
 * esperando vaga e segurou o grupo — a rodada nova ficou `pending` por 53 min.
 * A razão inteira está no cabeçalho do ci.yml.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

function ler(arquivo: string): string {
  return readFileSync(`.github/workflows/${arquivo}`, "utf-8");
}

// Sem parser YAML nas dependências (workflows-tem-permissions.test.ts):
// recorte do job pela indentação de dois espaços.
function blocoDoJob(texto: string, job: string): string {
  const inicio = texto.indexOf(`\n  ${job}:\n`);
  if (inicio < 0) throw new Error(`job ${job} não encontrado`);
  const resto = texto.slice(inicio + 1);
  const fim = resto.slice(1).search(/\n  [a-zA-Z0-9_-]+:\n/);
  return fim < 0 ? resto : resto.slice(0, fim + 1);
}

const PESADOS: Record<string, string[]> = {
  "ci.yml": ["verify-parte", "invariants-majors"],
  "e2e.yml": ["e2e-parte"],
  "perf.yml": ["build-and-size"],
  "publish-image.yml": ["build-and-push", "imagem-do-app-sobe", "imagens-de-fundo-sobem"],
};
const SEM_GRUPO: Record<string, string[]> = {
  "ci.yml": ["verify", "invariants", "invariants-alcance"],
  "e2e.yml": ["e2e", "e2e-alcance"],
  "publish-image.yml": ["imagens-ok", "promover-stable", "a-tag-veio-da-main"],
};

describe("concurrency: só nos jobs pesados", () => {
  it.each(Object.keys(PESADOS))("%s não declara concurrency no nível do workflow", (arq) => {
    expect(ler(arq)).not.toMatch(/^concurrency:/m);
  });

  it.each(Object.entries(PESADOS).flatMap(([a, js]) => js.map((j) => [a, j])))(
    "%s::%s tem grupo por PR e só cancela em pull_request (publish-image: também na main)",
    (arq, job) => {
      const bloco = blocoDoJob(ler(arq), job);
      expect(bloco).toMatch(/^ {4}concurrency:\n {6}group: .*github\.event\.pull_request\.number \|\| github\.ref/m);
      // Reentrada (aprovação de `action_required`, rerun) não cancela o head
      // atual de outro commit. Medido em 22/09/2026 (#1446, #1431). A razão
      // inteira está no cabeçalho do ci.yml.
      expect(bloco).toContain(
        "${{ github.event_name == 'pull_request' && github.run_attempt != '1' && format('-reentrada-{0}', github.event.pull_request.head.sha) || '' }}",
      );
      const cancela = bloco.match(/^ {6}cancel-in-progress: (.*)$/m)?.[1];
      expect(cancela).toBe(
        arq === "publish-image.yml"
          ? "${{ github.event_name == 'pull_request' || (github.event_name == 'push' && github.ref == 'refs/heads/main') }}"
          : "${{ github.event_name == 'pull_request' }}",
      );
    },
  );

  // O agregador não pode pertencer a grupo: é ele que, rodando com `always()`
  // numa rodada cancelada, seguraria o grupo da rodada nova.
  it.each(Object.entries(SEM_GRUPO).flatMap(([a, js]) => js.map((j) => [a, j])))(
    "%s::%s não pertence a grupo nenhum",
    (arq, job) => {
      expect(blocoDoJob(ler(arq), job)).not.toMatch(/^ {4}concurrency:/m);
    },
  );
});
