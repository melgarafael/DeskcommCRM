/**
 * O `e2e` (check OBRIGATÓRIO) passou a aceitar `skipped` das partes em DOIS
 * casos declarados, e só:
 *
 *  1. pull_request que não alcança nada que o e2e mede (`e2e-alcance` →
 *     `e2e=nao`, scripts/pr-alcanca-o-e2e.sh);
 *  2. run de head já superado (`e2e-alcance` → `head_velho=sim`, #2449): o
 *     passo inicial comparou o `head.sha` do evento com o head atual do PR e
 *     as partes pularam antes de disputar a vaga no grupo de concorrência —
 *     sem este ramo, o pulo do #2449 seria lido como reprovação pelo agregador.
 *
 * Toda porta que aceita `skipped` é uma porta por onde um desligamento passa
 * verde (issue #459, gatilho-dos-jobs-de-entrega.test.ts). Por isso o script do
 * agregador é EXECUTADO contra a matriz inteira de desfechos, e o conjunto do que
 * passa tem de ser exatamente o declarado — mesmo método de
 * imagens-ok-so-aceita-pulo-declarado.test.ts.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// Sem parser YAML nas dependências: recorte do PRIMEIRO `run: |` do job `e2e`.
function scriptDoAgregador(): string {
  const linhas = readFileSync(".github/workflows/e2e.yml", "utf-8").split("\n");
  const job = linhas.findIndex((l) => l === "  e2e:");
  const run = linhas.findIndex((l, i) => i > job && /^\s+run: \|$/.test(l));
  const indent = (linhas[run + 1] ?? "").match(/^\s*/)![0].length;
  const corpo: string[] = [];
  for (const l of linhas.slice(run + 1)) {
    if (l.trim() && l.match(/^\s*/)![0].length < indent) break;
    corpo.push(l.slice(indent));
  }
  return corpo.join("\n");
}

const SCRIPT = scriptDoAgregador();
const DESFECHOS = "success failure skipped cancelled";

// Uma invocação de bash para a matriz inteira; o código de saída é lido FORA de
// `if` (dentro da condição o bash desliga o `set -e` do subshell e a sonda
// aceitaria tudo). O eixo `HEAD` é o do #2449: sem exportá-lo o `set -u` do
// script derrubaria as 192 linhas com `unbound variable` e a sonda devolveria
// `[]` — o falso verde de vacuidade, em escala.
function combinacoesAceitas(): string[] {
  const programa = `
for HEAD in nao sim; do
for EVENTO in pull_request push; do
 for ALCANCE in sim nao ""; do
  for PORTAO in ${DESFECHOS}; do
   for PARTES in ${DESFECHOS}; do
    export HEAD_VELHO=$HEAD EVENTO ALCANCE PORTAO PARTES
    ( eval "$SCRIPT_DO_JOB" ) >/dev/null 2>&1
    rc=$?
    [ $rc -eq 0 ] && echo "$HEAD $EVENTO \${ALCANCE:-vazio} $PORTAO $PARTES"
   done
  done
 done
done
done
true`;
  return execFileSync("bash", ["-c", programa], {
    env: { ...process.env, SCRIPT_DO_JOB: SCRIPT, GITHUB_STEP_SUMMARY: "/dev/null" },
    encoding: "utf-8",
  })
    .split("\n")
    .filter(Boolean);
}

describe("e2e só aceita o pulo declarado", () => {
  it("controle positivo: o recorte pegou o script que lê os quatro resultados", () => {
    for (const v of ["$PORTAO", "$ALCANCE", "$PARTES", "$EVENTO", "$HEAD_VELHO"]) {
      expect(SCRIPT).toContain(v);
    }
  });

  it("da matriz inteira de desfechos (192), passa exatamente o que foi declarado", { timeout: 60_000 }, () => {
    expect(combinacoesAceitas().sort()).toEqual(
      [
        // PR que alcança: as partes têm de passar.
        "nao pull_request sim success success",
        // PR que não alcança: partes puladas, e SÓ puladas — `failure` não é pulo.
        "nao pull_request nao success skipped",
        // Fora de PR, a régua de antes: partes `success`, qualquer que seja o
        // output (fora de PR ele é sempre `sim`; `nao` aqui não abre porta).
        "nao push sim success success",
        "nao push nao success success",
        // Saída vazia com o job de alcance `success` não acontece (ele sempre
        // escreve a saída); se acontecer, só passa com as partes MEDIDAS.
        "nao pull_request vazio success success",
        "nao push vazio success success",
        // #2449: run de head superado — as partes pularam sem disputar a vaga.
        // O evento e o alcance não decidem aqui: quem decide é o pulo, e só
        // o pulo — `head=sim` com partes `success`/`failure` não passa, e
        // `PORTAO` segue exigindo `success` antes de qualquer porta.
        "sim pull_request sim success skipped",
        "sim pull_request nao success skipped",
        "sim pull_request vazio success skipped",
        "sim push sim success skipped",
        "sim push nao success skipped",
        "sim push vazio success skipped",
      ].sort(),
    );
  });
});
