/**
 * O RUN DO HEAD VELHO NÃO ROUBA A VAGA DO HEAD NOVO — #2449.
 *
 * ## O defeito, medido
 *
 * No #2437 (06/10/2026) o run 37491737771, do head ATUAL 8321bc06d, teve as
 * seis partes canceladas 7 s depois de começar, com a anotação
 *
 *     Canceling since a higher priority waiting request for
 *     e2e-e2e-parte1-2437 exists
 *
 * — e quem ficou com a vaga foi o run 37489636913, do head ANTERIOR ba6a71d70.
 * A chave de concorrência era a MESMA para os dois (o SHA do head só entrava
 * na reentrada, não na primeira tentativa), o Actions decide pela ordem de
 * chegada ao grupo e não pela idade do head, e o PR ficou vermelho sem defeito
 * nenhum — testando o head velho.
 *
 * ## As duas metades do conserto, e por que uma não basta
 *
 * (a) a chave da PRIMEIRA tentativa passa a levar `-head-<sha>`: heads
 *     diferentes nunca dividem grupo, então o run de um head superado não
 *     cancela (nem é cancelado pelo) run do head novo;
 * (b) o passo inicial do `e2e-alcance` compara o `head.sha` congelado no
 *     payload do evento com o head ATUAL do PR (API) e entrega
 *     `head_velho=sim` quando o run está velho — e o job das partes, que é
 *     quem pede vaga no grupo, é pulado por essa saída.
 *
 * Sem (b), (a) só trocava o prejuízo de lugar: o run velho continuaria com
 * grupo (só dele) e gastaria ~20 min de runner à toa. Sem (a), (b) não
 * alcançava o caso medido — o run velho já tinha o `e2e-alcance` decidido
 * ANTES do push novo, estava com as partes na fila do grupo, e nenhum passo
 * daquela altura enxerga o futuro.
 *
 * ## Por que ler o YAML E executar o bash
 *
 * Um workflow não roda em teste unitário (a mesma razão de
 * `e2e-avisa-antes-do-teto.test.ts`). Mas o que dá para prender aqui é o
 * contrato: a chave conter o SHA na primeira tentativa, o passo de comparação
 * existir, ser o PRIMEIRO do job e SAIR (exit 0, sem travar ninguém) em cada
 * um dos caminhos — e para isso o bloco `run:` é EXTRAÍDO do workflow e
 * EXECUTADO com um `gh` de mentira no PATH, no mesmo formato de
 * `guarda-da-release-reconhece-o-corte.test.ts`. Reescrever a regra em
 * TypeScript criaria uma segunda verdade sobre o que o CI faz, e a segunda
 * envelhece sozinha.
 *
 * ## Vacuidade
 *
 * Todos os casos derrubam quando o mecanismo é REMOVIDO: a extração da chave
 * acha `undefined`, a extração do passo acha índice -1, e a saída
 * `head_velho=` deixa de existir. O que não dá é um destes testes passando
 * num workflow que não tem o conserto — é o caso que mede se eles ainda têm o
 * que guardar.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const RAIZ = process.cwd();
const CAMINHO = ".github/workflows/e2e.yml";
const workflow = readFileSync(join(RAIZ, CAMINHO), "utf8");

// ─────────────────────────────────────────────────────────────────────────────
// (a) A CHAVE DE CONCORRÊNCIA DO JOB `e2e-parte`
// ─────────────────────────────────────────────────────────────────────────────

/** A linha `group:` do job que disputa a vaga — recorte pela indentação (sem parser YAML). */
const GRUPO = (() => {
  const m = workflow.match(/\n    concurrency:\n {6}group: (.*)\n/);
  return m?.[1] ?? "";
})();

/**
 * Os dois segmentos condicionais da chave, na forma em que o Actions os
 * avalia. `.*?` até o `|| '' }}` de cada um: o corpo tem `format('-head-{0}', …)`
 * e um `[^}]*` pararia no meio do `{0}`.
 */
const SEGMENTO_PRIMEIRA_TENTATIVA =
  /\$\{\{ github\.event_name == 'pull_request' && github\.run_attempt == '1' && (.*?) \|\| '' \}\}/.exec(GRUPO)?.[1] ?? "";
const SEGMENTO_REENTRADA =
  /\$\{\{ github\.event_name == 'pull_request' && github\.run_attempt != '1' && (.*?) \|\| '' \}\}/.exec(GRUPO)?.[1] ?? "";

/** O prefixo resolvido da chave para o PR 2437 — o mesmo prefixo da disputa medida. */
const BASE = "e2e-e2e-parte1-2437";

/**
 * A chave como o Actions monta, para um tentativa/head dados: o segmento
 * condicional avaliado com `evento=pull_request` coloca o SHA no `{0}` do
 * `format`. Não é uma reimplementação da regra — é a expressão EXTRAÍDA do
 * workflow sendo avaliada; se a forma do YAML mudar, os `expect` de extração
 * derrubam aqui antes de qualquer asserção passar errada.
 */
function chave(tentativa: number, sha: string): string {
  const segmento = tentativa === 1 ? SEGMENTO_PRIMEIRA_TENTATIVA : SEGMENTO_REENTRADA;
  const m = /format\('([^']*)',\s*github\.event\.pull_request\.head\.sha\)/.exec(segmento);
  if (!m) {
    throw new Error(
      `segmento da tentativa ${tentativa} não é mais um format(...) com o head.sha — o helper tem de ser reavaliado; segmento: ${segmento || "(vazio)"}`,
    );
  }
  const formato = m[1] ?? "";
  if (!formato) {
    throw new Error(
      `segmento da tentativa ${tentativa}: o format() saiu sem o placeholder do head.sha — o helper tem de ser reavaliado`,
    );
  }
  return BASE + formato.replace("{0}", sha);
}

// ─────────────────────────────────────────────────────────────────────────────
// (b) O PASSO INICIAL QUE COMPARA OS DOIS HEADS E SAI CEDO
// ─────────────────────────────────────────────────────────────────────────────

/** O bloco `run:` do passo que confere o head, extraído do workflow. */
function bashDoPassoDeHead(): string {
  const inicio = workflow.indexOf("name: O head deste run ainda é o head do PR?");
  expect(inicio, "o passo que confere o head sumiu do e2e.yml — o #2449 fica sem conserto").toBeGreaterThan(-1);
  const run = workflow.indexOf("run: |", inicio);
  expect(run, "o passo do head não tem bloco run:").toBeGreaterThan(-1);
  const linhas = workflow.slice(run + "run: |".length).split("\n").slice(1);
  const corpo: string[] = [];
  for (const l of linhas) {
    // O bloco acaba na primeira linha não-vazia com indentação menor que a dele
    // (10 espaços — `- name:` a 6, chaves do passo a 8).
    if (l.trim() !== "" && !l.startsWith("          ")) break;
    corpo.push(l.slice(10));
  }
  expect(corpo.join("\n"), "o bloco run: do passo do head veio vazio").toMatch(/GITHUB_OUTPUT/);
  return corpo.join("\n");
}

/**
 * O `gh` de mentira, no PATH antes do de verdade.
 *
 * O passo faz UMA pergunta (`pulls/<n> --jq .head.sha`); qualquer outra
 * chamada derruba o teste em vez de deixá-lo passar por engano — e a resposta
 * é escolhida por caso, para a rede nunca entrar na conta do resultado.
 */
let stub: string;
function montarStub(dir: string) {
  const caminho = join(dir, "gh");
  writeFileSync(
    caminho,
    [
      "#!/usr/bin/env bash",
      'if [ "${GH_STUB_FALHA:-0}" = "1" ]; then echo "gh: erro simulado de API" >&2; exit 1; fi',
      'case "$*" in',
      "  *\"--jq .head.sha\"*) printf '%s\\n' \"${GH_HEAD_ATUAL}\" ;;",
      '  *) echo "gh stub: chamada inesperada: $*" >&2; exit 1 ;;',
      "esac",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(caminho, 0o755);
}

let githubOutput: string;

type Cenario = {
  evento?: string;
  headDoEvento?: string;
  headAtual?: string;
  falhaNaApi?: boolean;
};

/** Roda o bash EXTRAÍDO do workflow com o ambiente que o passo tem no CI. */
function rodarPasso(c: Cenario): { stdout: string; output: string } {
  writeFileSync(githubOutput, "");
  const env = {
    ...process.env,
    PATH: `${stub}:${process.env.PATH}`,
    GH_STUB_FALHA: c.falhaNaApi ? "1" : "0",
    GH_HEAD_ATUAL: c.headAtual ?? "",
    GITHUB_OUTPUT: githubOutput,
    GITHUB_EVENT_NAME: c.evento ?? "pull_request",
    GITHUB_REPOSITORY: "qualquer/repo",
    GH_TOKEN: "token-de-mentira",
    PR: "2437",
    HEAD_DO_EVENTO: c.headDoEvento ?? "8321bc06d",
  };
  try {
    const stdout = execFileSync("bash", ["-c", bashDoPassoDeHead()], { encoding: "utf8", env });
    return { stdout, output: readFileSync(githubOutput, "utf8") };
  } catch (err) {
    // Diagnóstico que não chega ao log é diagnóstico que não existe: o
    // `execFileSync` joga o stderr fora na mensagem padrão.
    const e = err as { status?: number; stderr?: string; stdout?: string };
    throw new Error(
      `o passo do head derrubou (exit=${e.status ?? "?"})\nstderr: ${e.stderr ?? "(vazio)"}\nstdout: ${e.stdout ?? "(vazio)"}`,
    );
  }
}

beforeAll(() => {
  stub = mkdtempSync(join(tmpdir(), "gh-head-velho-"));
  montarStub(stub);
  githubOutput = join(stub, "github-output");
});

afterAll(() => {
  if (stub) rmSync(stub, { recursive: true, force: true });
});

describe("a chave da concorrência leva o SHA do head já na primeira tentativa (#2449)", () => {
  it("o grupo existe e continua nomeando o PR — guarda de vacuidade", () => {
    expect(GRUPO, "não achei a linha `group:` do job e2e-parte").not.toBe("");
    expect(GRUPO).toContain("github.event.pull_request.number || github.ref");
    expect(SEGMENTO_REENTRADA, "sumiu o segmento de reentrada da chave").not.toBe("");
  });

  it("a PRIMEIRA tentativa tem um segmento condicionado a run_attempt == '1' que cola o head.sha", () => {
    // Este é o caso que DERRUBA com a chave antiga: lá o SHA só aparecia no
    // segmento de reentrada (`run_attempt != '1'`), e a primeira tentativa —
    // exatamente a do run 37491737771 — disputava `e2e-e2e-parte1-2437` sem
    // SHA nenhum.
    expect(
      GRUPO,
      "a chave da primeira tentativa não leva o SHA do head: dois heads voltam a disputar o mesmo grupo (#2449)",
    ).toMatch(/github\.run_attempt == '1' && format\(/);
    expect(SEGMENTO_PRIMEIRA_TENTATIVA, "o segmento da primeira tentativa não referencia o head.sha").toMatch(
      /github\.event\.pull_request\.head\.sha/,
    );
  });

  it("heads diferentes geram chaves diferentes na primeira tentativa", () => {
    // O par medido no #2437: ba6a71d70 (velho) × 8321bc06d (novo). Antes do
    // conserto as duas montavam `e2e-e2e-parte1-2437` e o Actions escolhia
    // pela ordem de chegada ao grupo.
    const doVelho = chave(1, "ba6a71d70");
    const doNovo = chave(1, "8321bc06d");
    expect(doNovo).toContain("8321bc06d");
    expect(doVelho).not.toBe(doNovo);
  });

  it("a reentrada continua com chave própria — rerun não cancela o head atual (#1446)", () => {
    // A saída da #1446/#1431 não pode se perder no conserto da #2449: o SHA
    // entrou NA PRIMEIRA tentativa, e a reentrada mantém sufixo próprio.
    expect(chave(2, "8321bc06d")).not.toBe(chave(1, "8321bc06d"));
  });
});

describe("o passo inicial compara o head do evento com o head atual do PR e sai cedo", () => {
  it("é o PRIMEIRO passo do e2e-alcance — antes do checkout e da pergunta de alcance", () => {
    const inicioJob = workflow.indexOf("\n  e2e-alcance:\n");
    expect(inicioJob, "o job e2e-alcance sumiu do workflow").toBeGreaterThan(-1);
    const passo = workflow.indexOf("name: O head deste run ainda é o head do PR?");
    expect(passo, "o passo que confere o head não está no workflow").toBeGreaterThan(inicioJob);
    // O primeiro `checkout` do arquivo é o do próprio e2e-alcance: o passo do
    // head vem ANTES — ele não lê código nenhum, só a API do PR.
    const checkout = workflow.indexOf("uses: actions/checkout@v7");
    expect(checkout, "o passo do head veio depois do checkout — deixou de ser o inicial").toBeGreaterThan(passo);
    const alcance = workflow.indexOf("name: O PR alcança o que o e2e mede?");
    expect(alcance).toBeGreaterThan(passo);
  });

  it("head VELHO: entrega head_velho=sim e sai cedo (exit 0, sem travar o PR)", () => {
    // O caso medido: evento do run antigo ba6a71d70, PR já em 8321bc06d.
    const r = rodarPasso({ headDoEvento: "ba6a71d70", headAtual: "8321bc06d" });
    expect(r.output).toContain("head_velho=sim");
    expect(r.stdout, "a saída não diz que o run está velho nem que ele sai cedo").toMatch(/head velho:.*sai cedo/);
    expect(r.stdout).not.toMatch(/segue sendo o head/);
  });

  it("head ATUAL: entrega head_velho=nao e o run segue normalmente (controle)", () => {
    // Sem este caso, "sempre sim" satisfaria o anterior — e todo PR pularia
    // o e2e inteiro.
    const r = rodarPasso({ headDoEvento: "8321bc06d", headAtual: "8321bc06d" });
    expect(r.output).toContain("head_velho=nao");
    expect(r.stdout).toMatch(/segue sendo o head/);
    expect(r.output).not.toContain("head_velho=sim");
  });

  it("push na main: não há head de PR, sai cedo sem chamar a API", () => {
    // O `gh` de mentira DERRUBA chamada inesperada — então este caso também
    // prova que nenhum `gh api` acontece fora de pull_request.
    const r = rodarPasso({ evento: "push", headAtual: "nao-deveria-ser-lido" });
    expect(r.output).toContain("head_velho=nao");
    expect(r.stdout).toMatch(/não há head de PR/);
  });

  it("falha da API: NÃO declara o run velho — sem resposta não há como afirmar", () => {
    // Um gate que trava todo PR por falta de uma leitura seria pior que o
    // defeito (#2449, direção (b)): o caminho de erro tem de seguir, e é
    // `head_velho=nao`, não `sim` e não exit 1.
    const r = rodarPasso({ headDoEvento: "ba6a71d70", headAtual: "8321bc06d", falhaNaApi: true });
    expect(r.output).toContain("head_velho=nao");
    expect(r.stdout).toMatch(/não consegui ler o head atual/);
    expect(r.stdout).not.toMatch(/head velho:/);
  });

  it("API devolvendo head.sha vazio: segue, sem declarar o run velho", () => {
    const r = rodarPasso({ headDoEvento: "ba6a71d70", headAtual: "" });
    expect(r.output).toContain("head_velho=nao");
    expect(r.stdout).toMatch(/devolveu head\.sha vazio/);
    expect(r.stdout).not.toMatch(/head velho:/);
  });
});

describe("a saída do passo chega onde decide — sem ela o passo é decoração", () => {
  it("o e2e-alcance publica head_velho como output", () => {
    expect(workflow).toContain("head_velho: ${{ steps.head_velho.outputs.head_velho }}");
  });

  it("as partes só rodam com head_velho != 'sim' — é o pulo que tira o run velho da fila do grupo", () => {
    expect(workflow).toMatch(
      /if: needs\.e2e-alcance\.outputs\.e2e == 'sim' && needs\.e2e-alcance\.outputs\.head_velho != 'sim'/,
    );
  });

  it("o agregador aceita skipped quando o run é de head velho, com mensagem própria", () => {
    // Sem o ramo, o agregador reprovaria o run velho (partes `skipped` sem
    // `e2e=nao`) ou — pior — imprimiria a frase do pulo por alcance de PR,
    // que seria mentira sobre o motivo real.
    expect(workflow).toContain("HEAD_VELHO: ${{ needs.e2e-alcance.outputs.head_velho }}");
    expect(workflow).toMatch(/if \[ "\$HEAD_VELHO" = "sim" \]; then\n {12}\[ "\$PARTES" = "skipped" \]/);
    expect(workflow).toContain("run de head superado");
  });
});
