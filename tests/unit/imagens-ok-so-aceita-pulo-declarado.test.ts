/**
 * O `imagens-ok` (check OBRIGATÓRIO) passou a aceitar `skipped` em três casos,
 * e só neles:
 *
 *   - `build-and-push` pulado em pull_request — lá ele só construía e
 *     descartava as mesmas imagens que os jobs `*-sobe` constroem;
 *   - `juntar-manifestos` pulado em pull_request — não há imagens publicadas
 *     nesse evento;
 *   - os jobs `*-sobe` pulados em pull_request que não alcança imagem nenhuma
 *     (`a-tag-veio-da-main` → `imagem=nao`, scripts/pr-mexe-na-imagem.sh).
 *
 * Toda porta que aceita `skipped` é uma porta por onde um desligamento passa
 * verde (é o buraco da issue #459, em gatilho-dos-jobs-de-entrega.test.ts).
 * Por isso aqui não se lê o script: ele é EXECUTADO contra a matriz inteira de
 * desfechos, e o conjunto do que passa tem de ser exatamente o declarado.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// Sem parser YAML nas dependências (mesma constatação de
// workflows-tem-permissions.test.ts): recorte por indentação + controle positivo.
function scriptDoImagensOk(): string {
  const linhas = readFileSync(".github/workflows/publish-image.yml", "utf-8").split("\n");
  const job = linhas.findIndex((l) => l === "  imagens-ok:");
  const run = linhas.findIndex((l, i) => i > job && /^\s+run: \|$/.test(l));
  const indent = (linhas[run + 1] ?? "").match(/^\s*/)![0].length;
  const corpo: string[] = [];
  for (const l of linhas.slice(run + 1)) {
    if (l.trim() && l.match(/^\s*/)![0].length < indent) break;
    corpo.push(l.slice(indent));
  }
  return corpo.join("\n");
}

const DESFECHOS = "success failure skipped cancelled";

// A matriz inteira numa invocação só de bash (4096 processos filhos do Node
// custavam minutos numa máquina carregada). Cada combinação roda o script num
// SUBSHELL, e o código de saída é lido FORA de um `if`: dentro da condição de
// um `if` o bash desliga o `set -e` do subshell, e o `[ ]` que falhou deixaria
// de reprovar — a sonda aceitaria tudo.
function combinacoesAceitas(): string[] {
  const programa = `
for EVENTO in pull_request push; do
 for ALCANCE in sim nao; do
  for PORTAO in ${DESFECHOS}; do
   for BUILD in ${DESFECHOS}; do
    for MANIFESTO in ${DESFECHOS}; do
     for APP in ${DESFECHOS}; do
      for FUNDO in ${DESFECHOS}; do
      export EVENTO ALCANCE PORTAO BUILD MANIFESTO APP FUNDO
      ( eval "$SCRIPT_DO_JOB" ) >/dev/null 2>&1
      rc=$?
      [ $rc -eq 0 ] && echo "$EVENTO $ALCANCE $PORTAO $BUILD $MANIFESTO $APP $FUNDO"
      done
      done
     done
   done
  done
 done
done
true`;
  return execFileSync("bash", ["-c", programa], {
    env: { ...process.env, SCRIPT_DO_JOB: SCRIPT },
    encoding: "utf-8",
  })
    .split("\n")
    .filter(Boolean);
}

const SCRIPT = scriptDoImagensOk();

describe("imagens-ok só aceita o pulo declarado", () => {
  it("controle positivo: o recorte pegou o script que lê os cinco resultados", () => {
    for (const v of ["$PORTAO", "$BUILD", "$MANIFESTO", "$APP", "$FUNDO", "$ALCANCE", "$EVENTO"]) {
      expect(SCRIPT).toContain(v);
    }
  });

  // 4096 subshells: menos de um segundo numa máquina ociosa, e passou de 15 s
  // numa com carga 90. O teto é para a máquina, não para o script.
  it("da matriz inteira de desfechos (4096), passa exatamente o que foi declarado", { timeout: 60_000 }, () => {
    const passam = combinacoesAceitas();
    expect(passam.sort()).toEqual(
      [
        // PR que alcança imagem: os dois `*-sobe` têm de passar.
        "pull_request sim success skipped skipped success success",
        // PR que não alcança: tudo pulado, e SÓ pulado — `failure` não é pulo.
        "pull_request nao success skipped skipped skipped skipped",
        // Fora de PR, a régua de antes: tudo `success`, qualquer que seja o
        // output (fora de PR ele é sempre `sim`; `nao` aqui é impossível, e
        // mesmo assim não abre porta).
        "push sim success success success success success",
        "push nao success success success success success",
      ].sort(),
    );
  });
});
