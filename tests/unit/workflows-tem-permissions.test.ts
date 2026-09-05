/**
 * TODO JOB DE WORKFLOW DECLARA SEU PRIVILÉGIO — E NENHUM GANHA ESCRITA SEM RAZÃO ESCRITA.
 *
 * ## Por que este arquivo existe
 *
 * Quatro alertas do CodeQL (`actions/missing-workflow-permissions`, #1/#2/#4/#9)
 * apontavam os quatro jobs de `ci`, `perf` e `e2e` sem bloco `permissions`. Sem ele,
 * o GITHUB_TOKEN do job herda o default do REPOSITÓRIO — uma configuração que vive
 * fora do repo, muda num clique, não passa por PR e não deixa rastro em lugar nenhum
 * que este projeto revise. Hoje esse default é `read`; o conserto não foi apagar um
 * vazamento em vigor, foi mover a garantia para dentro do código.
 *
 * O conserto sem esta guarda dura até o próximo job. Um job novo nasce sem bloco e
 * herda o default de novo — e o CodeQL só reabriria o alerta na varredura semanal,
 * depois do merge. Aqui reprova no `verify`, que é check obrigatório.
 *
 * ## O predicado é o do próprio scanner, não uma aproximação
 *
 * A query `MissingActionsPermissions.ql` avalia
 * `exists(job.getPermissions()) or exists(job.getEnclosingWorkflow().getPermissions())`
 * — bloco no job OU no topo do workflow. É esse `or` que este teste replica. Por isso
 * `contents: read` no topo de `ci.yml` satisfaz os dois jobs dele, e por isso o
 * `packages: write` por job de `publish-image.yml` também está certo: cada privilégio
 * declarado no menor escopo que precisa dele.
 *
 * ## O que a segunda asserção compra que a primeira não compra
 *
 * "Tem bloco `permissions`" é satisfeito por `permissions: write-all`. A asserção de
 * escrita congela a dívida existente (`packages: write`, que publica a imagem no GHCR)
 * e reprova qualquer escopo de escrita NOVO até alguém escrever a justificativa aqui.
 * Sem ela, o gate mede a presença de um bloco e não o privilégio que ele concede.
 *
 * ## Não há parser YAML nas dependências
 *
 * `yaml`/`js-yaml` não estão em `dependencies` nem `devDependencies` (js-yaml existe
 * só como transitiva do eslint, e depender de transitiva é dívida). Então: regex
 * estreito + CONTROLE POSITIVO — sem ele, um regex que parou de casar devolve lista
 * vazia e o gate fica verde vigiando nada, que é o modo de falha mais comum desta
 * classe de teste.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const DIR = join(process.cwd(), ".github/workflows");

/**
 * Escopos de ESCRITA aceitos hoje, com a razão escrita ao lado.
 *
 * Entrada nova aqui é decisão consciente: o teste reprova até que alguém a
 * acrescente, e acrescentar sem razão é visível em code review.
 */
const ESCRITA_JUSTIFICADA: Record<string, string> = {
  "publish-image.yml::packages: write":
    "publica a imagem do app no GHCR — é o artefato que o self-hoster instala",
  "acolhida.yml::pull-requests: write":
    "comenta a acolhida no PR de fork; é o ÚNICO escopo do workflow (o bloco zera o resto), " +
    "e o job não faz checkout nem usa action nenhuma — ver tests/unit/acolhida-nao-toca-no-fork.test.ts",
};

interface Workflow {
  arquivo: string;
  linhas: string[];
  /** `permissions:` na coluna 0 vale para todos os jobs do arquivo. */
  temPermissionsNoTopo: boolean;
  jobs: { nome: string; linha: number; temPermissions: boolean }[];
}

function lerWorkflows(): Workflow[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .map((arquivo) => {
      const linhas = readFileSync(join(DIR, arquivo), "utf8").split("\n");
      // Comentário não conta: um `#` mencionando `permissions:` não pode satisfazer
      // o gate. Este arquivo tem comentários longos justamente sobre permissions.
      const efetivas = linhas.map((l) => (l.trimStart().startsWith("#") ? "" : l));

      const temPermissionsNoTopo = efetivas.some((l) => /^permissions:/.test(l));

      const jobs: Workflow["jobs"] = [];
      const iJobs = efetivas.findIndex((l) => /^jobs:\s*$/.test(l));
      if (iJobs !== -1) {
        for (let i = iJobs + 1; i < efetivas.length; i++) {
          const l = efetivas[i]!;
          if (/^\S/.test(l)) break; // saiu do bloco `jobs:`
          const m = l.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
          if (!m) continue;
          // O corpo do job vai até o próximo job (indentação de 2) ou o fim do bloco.
          let fim = efetivas.length;
          for (let j = i + 1; j < efetivas.length; j++) {
            if (/^\S/.test(efetivas[j]!) || /^ {2}[A-Za-z0-9_-]+:\s*$/.test(efetivas[j]!)) {
              fim = j;
              break;
            }
          }
          jobs.push({
            nome: m[1]!,
            linha: i + 1,
            temPermissions: efetivas.slice(i + 1, fim).some((x) => /^ {4}permissions:/.test(x)),
          });
        }
      }
      return { arquivo, linhas, temPermissionsNoTopo, jobs };
    });
}

describe("workflows declaram o privilégio do GITHUB_TOKEN", () => {
  it("o instrumento está vivo: lê os workflows e enxerga os jobs", () => {
    // Controle positivo. Se o regex de job parar de casar (mudança de formatação,
    // `jobs:` com comentário na mesma linha), as asserções seguintes passam por
    // vacuidade — lista vazia satisfaz "todo elemento da lista".
    const ws = lerWorkflows();
    expect(ws.length, "workflows lidos em .github/workflows").toBeGreaterThanOrEqual(4);
    const totalJobs = ws.reduce((n, w) => n + w.jobs.length, 0);
    expect(totalJobs, "jobs encontrados no total").toBeGreaterThanOrEqual(5);
  });

  it("todo job tem permissions — no job ou no topo do workflow", () => {
    const semGuarda = lerWorkflows()
      .flatMap((w) =>
        w.jobs
          .filter((j) => !j.temPermissions && !w.temPermissionsNoTopo)
          .map((j) => `${w.arquivo}:${j.linha} (job "${j.nome}")`),
      )
      .sort();

    // Este é exatamente o conjunto que o CodeQL acusava antes do conserto — e a
    // mensagem nomeia o arquivo e a linha para o próximo leitor não ter de procurar.
    expect(semGuarda, "job sem permissions: o token herda o default do REPOSITÓRIO").toEqual([]);
  });

  it("escopo de escrita só existe com justificativa escrita aqui", () => {
    const naoJustificados = lerWorkflows()
      .flatMap((w) =>
        w.linhas
          .filter((l) => !l.trimStart().startsWith("#"))
          .map((l) => l.match(/^\s+([a-z-]+:\s*write(?:-all)?)\s*$/))
          .filter((m): m is RegExpMatchArray => m !== null)
          .map((m) => `${w.arquivo}::${m[1]!.replace(/\s+/g, " ")}`),
      )
      .filter((chave) => !(chave in ESCRITA_JUSTIFICADA))
      .sort();

    expect(
      naoJustificados,
      "escopo de escrita novo: acrescente a ESCRITA_JUSTIFICADA com a razão, ou tire o privilégio",
    ).toEqual([]);
  });
});
