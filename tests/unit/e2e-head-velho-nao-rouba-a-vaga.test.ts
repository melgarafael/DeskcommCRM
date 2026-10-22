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
 * ## As duas direções da issue, e qual ficou
 *
 * (b) FICOU. O passo inicial do `e2e-alcance` compara o `head.sha` congelado no
 *     payload do evento com o head ATUAL do PR (API) e entrega `head_velho=sim`
 *     quando o run está velho — e o job das partes, que é quem pede vaga no
 *     grupo, é pulado por essa saída. Ele resolve o caso medido sozinho: lá os
 *     dois alcances foram liberados no mesmo segundo, depois do push novo, e o
 *     run velho teria lido o head novo e pulado as partes ANTES de pedir vaga.
 *
 * (a) NÃO entrou, e a decisão é medida. Pôr `-head-<sha>` na chave da PRIMEIRA
 *     tentativa faz heads diferentes nunca dividirem grupo, mas o custo medido
 *     (08 a 10/10/2026) é que, de 77 runs do e2e cancelados em PR, em **72** o
 *     run seguinte nasceu DEPOIS de o alcance do run velho terminar, com as
 *     partes já rodando: sem a chave por número do PR esses 72 deixariam de ser
 *     cancelados pelo push novo e iriam até o fim, 6 partes cada — e o passo (b)
 *     não alcança esses runs, porque o alcance deles já tinha decidido. Quem
 *     cancela a rodada superada é o GRUPO, e ele só faz isso com a chave por
 *     número do PR, como no `ci.yml` e no `perf.yml`. A outra metade da direção
 *     (manter o SHA e cancelar o run velho pelo passo) não fecha em PR de fork:
 *     lá o token é só leitura.
 *
 * E o agregador `e2e` REPROVA o run de head superado, com mensagem própria: o
 * check daquele run está num SHA que já não é o head do PR, então o verde ali —
 * ou o pulo lido como verde — não vale como medição de nada.
 *
 * ## Por que ler o YAML E executar o bash
 *
 * Um workflow não roda em teste unitário (a mesma razão de
 * `e2e-avisa-antes-do-teto.test.ts`). Mas o que dá para prender aqui é o
 * contrato: a chave ser a mesma forma do `ci.yml` (PR + reentrada), o passo de
 * comparação existir, ser o PRIMEIRO do job e SAIR (exit 0, sem travar ninguém)
 * em cada um dos caminhos, e o agregador reprovar o run velho — e para isso os
 * blocos `run:` são EXTRAÍDOS do workflow e EXECUTADOS com um `gh` de mentira no
 * PATH, no mesmo formato de `guarda-da-release-reconhece-o-corte.test.ts`.
 * Reescrever a regra em TypeScript criaria uma segunda verdade sobre o que o CI
 * faz, e a segunda envelhece sozinha.
 *
 * ## Vacuidade
 *
 * Todos os casos derrubam quando o mecanismo é REMOVIDO: a extração do passo
 * acha índice -1, a saída `head_velho=` deixa de existir, e o `exit 1` do ramo
 * do head superado devolve o verde sem medição (#2449). O que não dá é um
 * destes testes passando num workflow que não tem o conserto — é o caso que
 * mede se eles ainda têm o que guardar.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const RAIZ = process.cwd();
const CAMINHO = ".github/workflows/e2e.yml";
const workflow = readFileSync(join(RAIZ, CAMINHO), "utf8");

// ─────────────────────────────────────────────────────────────────────────────
// A CHAVE DE CONCORRÊNCIA DO JOB `e2e-parte` — POR NÚMERO DO PR (#2449)
// ─────────────────────────────────────────────────────────────────────────────

/** A linha `group:` do job que disputa a vaga — recorte pela indentação (sem parser YAML). */
const GRUPO = (() => {
  const m = workflow.match(/\n    concurrency:\n {6}group: (.*)\n/);
  return m?.[1] ?? "";
})();

/**
 * O segmento condicional da REENTRADA, na forma em que o Actions o avalia:
 * `.*?` até o `|| '' }}` (um `[^}]*` pararia no meio do `{0}` do `format`). O
 * segmento da primeira tentativa NÃO existe mais — é o que o #2449 decidiu, e o
 * teste do grupo mede isso.
 */
const SEGMENTO_REENTRADA =
  /\$\{\{ github\.event_name == 'pull_request' && github\.run_attempt != '1' && (.*?) \|\| '' \}\}/.exec(GRUPO)?.[1] ?? "";

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

/**
 * A chave como o Actions a monta para o PR 2437 — a MESMA forma que o `ci.yml`
 * (`verify-parte`) e o `perf.yml` (`build-and-size`) já usavam: o número do PR
 * no grupo, e o SHA do head SÓ na reentrada. Fixada literal de propósito: o
 * texto da chave É o contrato de cancelamento da rodada superada, e um
 * `toContain` deixaria passar de volta o segmento `-head-<sha>` que a direção
 * (a) do #2449 pedia e a medição recusou.
 */
const CHAVE_ESPERADA =
  "${{ github.workflow }}-e2e-parte${{ matrix.parte }}-${{ github.event.pull_request.number || github.ref }}${{ github.event_name == 'pull_request' && github.run_attempt != '1' && format('-reentrada-{0}', github.event.pull_request.head.sha) || '' }}";

describe("a chave da concorrência é por número do PR — sem o SHA do head (#2449)", () => {
  it("o grupo existe e continua nomeando o PR — guarda de vacuidade", () => {
    expect(GRUPO, "não achei a linha `group:` do job e2e-parte").not.toBe("");
    expect(GRUPO).toContain("github.event.pull_request.number || github.ref");
    expect(SEGMENTO_REENTRADA, "sumiu o segmento de reentrada da chave").not.toBe("");
  });

  it("a PRIMEIRA tentativa NÃO tem segmento por SHA — a rodada superada tem de continuar sendo cancelada", () => {
    // Este é o caso que guarda a decisão do #2449. A direção (a) da issue
    // punha `-head-<sha>` aqui, e ela foi MEDIDA antes de partir: de 77 runs
    // do e2e cancelados em PR (08 a 10/10/2026), em 72 o run seguinte nasceu
    // DEPOIS de o alcance do run velho terminar, com as partes já rodando —
    // com o SHA na chave esses 72 deixariam de ser cancelados pelo push novo,
    // e o passo (b) não os alcança.
    expect(GRUPO, "o SHA do head voltou para a chave da primeira tentativa (#2449)").not.toMatch(
      /github\.run_attempt == '1'/,
    );
    expect(GRUPO, "a chave carrega um format('-head-…') de novo").not.toMatch(/-head-/);
  });

  it("a chave é a mesma forma do ci.yml/perf.yml — PR no grupo, SHA só na reentrada (#1446)", () => {
    // A reentrada mantém sufixo próprio pela razão medida em d4c2b3f61
    // (#1446, #1431): rerun e aprovação de `action_required` não cancelam o
    // head atual de outro commit. O literal pinado também mede que o e2e.yml
    // deixou de ser o único dos três com uma chave diferente.
    expect(GRUPO).toBe(CHAVE_ESPERADA);
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

  it("o agregador REPROVA o run de head velho, com mensagem própria (#2449)", () => {
    // O check obrigatório `e2e`, num run de head superado, fica num SHA que já
    // não é o head do PR: o verde ali — ou o pulo lido como verde — não vale
    // como medição de nada, e só pesa quando o sinal está errado (o PR entra
    // com `e2e` satisfeito sem que parte nenhuma tenha rodado). Aqui o script
    // do agregador é EXECUTADO, não lido: é a execução que devolve o `exit 1`.
    expect(workflow).toContain("HEAD_VELHO: ${{ needs.e2e-alcance.outputs.head_velho }}");

    const velho = rodarAgregador({
      EVENTO: "pull_request",
      PORTAO: "success",
      ALCANCE: "sim",
      HEAD_VELHO: "sim",
      PARTES: "skipped",
    });
    expect(
      velho.rc,
      `o agregador aceitou o run de head velho (rc=${velho.rc}) — é o verde sem medição que o #2449 fecha. Saída: ${velho.saida}`,
    ).not.toBe(0);
    expect(velho.saida, "o agregador reprovou sem dizer POR QUE — o motivo tem de estar no log").toMatch(
      /head já superado|head superado/,
    );
    expect(velho.saida, "a mensagem não diz que o check está num SHA que já não é o head").toMatch(
      /SHA que já não é o head/,
    );
  });

  it("controle positivo: o MESMO script do agregador sai 0 no caminho normal", () => {
    // Sem este controle, "sempre reprova" satisfaria o caso de cima — e um
    // agregador que reprova todo PR é pior que o defeito que ele fecha.
    expect(AGREGADOR, "o recorte do agregador veio vazio — o teste de cima passaria por vacuidade").toContain(
      "HEAD_VELHO",
    );
    const atual = rodarAgregador({
      EVENTO: "pull_request",
      PORTAO: "success",
      ALCANCE: "sim",
      HEAD_VELHO: "nao",
      PARTES: "success",
    });
    expect(atual.rc, `o agregador reprovou o run do head atual. Saída: ${atual.saida}`).toBe(0);

    // E o único pulo que continua declarado segue aceito (e2e=nao em PR).
    const naoAlcanca = rodarAgregador({
      EVENTO: "pull_request",
      PORTAO: "success",
      ALCANCE: "nao",
      HEAD_VELHO: "nao",
      PARTES: "skipped",
    });
    expect(
      naoAlcanca.rc,
      `o agregador passou a reprovar o pulo por alcance (e2e=nao), que é declarado. Saída: ${naoAlcanca.saida}`,
    ).toBe(0);
  });
});

/** O bloco `run:` do PRIMEIRO passo do job `e2e` — o mesmo recorte de `e2e-so-aceita-pulo-declarado.test.ts`. */
function scriptDoAgregador(): string {
  const linhas = workflow.split("\n");
  const job = linhas.findIndex((l) => l === "  e2e:");
  expect(job, "o job agregador `e2e` sumiu do workflow").toBeGreaterThan(-1);
  const run = linhas.findIndex((l, i) => i > job && /^\s+run: \|$/.test(l));
  expect(run, "o agregador não tem bloco `run: |`").toBeGreaterThan(-1);
  const indent = (linhas[run + 1] ?? "").match(/^\s*/)![0].length;
  const corpo: string[] = [];
  for (const l of linhas.slice(run + 1)) {
    if (l.trim() && l.match(/^\s*/)![0].length < indent) break;
    corpo.push(l.slice(indent));
  }
  return corpo.join("\n");
}

const AGREGADOR = scriptDoAgregador();

/**
 * Roda o script do agregador com os `needs` que o job tem no CI. O script sai
 * com `exit` próprio, então o código é lido FORA de `if` (`spawnSync`, não um
 * `if` no bash): dentro da condição o `set -e` do subshell desligaria e a sonda
 * aceitaria tudo — o falso verde que `e2e-so-aceita-pulo-declarado.test.ts`
 * documenta em escala.
 */
function rodarAgregador(env: Record<string, string>): { rc: number; saida: string } {
  const r = spawnSync("bash", ["-c", 'eval "$SCRIPT_DO_JOB"'], {
    encoding: "utf-8",
    env: { ...process.env, GITHUB_STEP_SUMMARY: "/dev/null", SCRIPT_DO_JOB: AGREGADOR, ...env },
  });
  return { rc: r.status ?? -1, saida: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}
