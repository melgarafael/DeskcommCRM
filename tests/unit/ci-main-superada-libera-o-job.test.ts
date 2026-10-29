/**
 * Avalia a política que o Actions receberá, em vez de comparar a expressão com
 * outra string igual. Cancelamento só tem efeito dentro do mesmo grupo; não é
 * prova de testes nem um comparador de ancestrais: a ordem é a de entrada.
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const ALVOS = [
  ["ci.yml", "verify-parte"],
  ["ci.yml", "invariants-majors"],
  ["e2e.yml", "e2e-parte"],
  ["perf.yml", "build-and-size"],
] as const;

function politica(arquivo: string, job: string) {
  const yaml = readFileSync(`.github/workflows/${arquivo}`, "utf8");
  const inicio = yaml.indexOf(`\n  ${job}:\n`);
  if (inicio < 0) throw new Error(`Job ausente: ${job}`);
  const resto = yaml.slice(inicio + 1);
  const fim = resto.slice(1).search(/\n  [\w-]+:\n/);
  const bloco = fim < 0 ? resto : resto.slice(0, fim + 1);
  const grupo = bloco.match(/^ {6}group: (.+)$/m)?.[1];
  const cancela = bloco.match(/^ {6}cancel-in-progress: (.+)$/m)?.[1];
  const workflow = yaml.match(/^name: (.+)$/m)?.[1];
  if (!grupo || !cancela || !workflow) throw new Error(`Política ausente: ${job}`);
  return { grupo, cancela, workflow };
}

type Contexto = {
  evento: string;
  ref: string;
  workflow: string;
  head: string;
  tentativa: string;
  pr?: number;
  perna: string;
  imagem: string;
  arquitetura: string;
};

// Mesmo subconjunto de expressões do controle de publicação existente. Fonte:
// arquivos versionados, sem input HTTP. Tokens/contextos não suportados falham.
function interpolar(modelo: string, c: Contexto): string {
  return modelo.replace(/\$\{\{ (.+?) \}\}/g, (_, expressao: string) => {
    const js = expressao
      .replace(/github\.event\.pull_request\.number/g, "c.pr")
      .replace(/github\.event\.pull_request\.head\.sha/g, "c.head")
      .replace(/github\.sha\b/g, "c.head")
      .replace(/github\.run_attempt/g, "c.tentativa")
      .replace(/github\.event_name/g, "c.evento")
      .replace(/github\.workflow/g, "c.workflow")
      .replace(/github\.ref\b/g, "c.ref")
      .replace(/matrix\.(parte|pg)\b/g, "c.perna")
      .replace(/matrix\.name\b/g, "c.imagem")
      .replace(/matrix\.arch\b/g, "c.arquitetura")
      .replace(/==/g, "===")
      .replace(/!=/g, "!==");
    const format = (modelo: string, ...args: unknown[]) =>
      modelo.replace(/\{(\d+)\}/g, (_, i: string) => String(args[Number(i)]));
    return String(new Function("c", "format", `return (${js});`)(c, format));
  });
}

function contexto(workflow: string, alteracoes: Partial<Contexto> = {}): Contexto {
  return {
    evento: "push",
    ref: "refs/heads/main",
    workflow,
    head: "novo",
    tentativa: "1",
    perna: "1",
    imagem: "deskcommcrm",
    arquitetura: "amd64",
    ...alteracoes,
  };
}

describe.each(ALVOS)("%s::%s — revisão superada não ocupa o job atual", (arquivo, job) => {
  const p = politica(arquivo, job);
  const grupo = (c: Contexto) => interpolar(p.grupo, c).toLowerCase();
  const cancela = (chegando: Contexto, anterior: Contexto) =>
    grupo(chegando) === grupo(anterior) && interpolar(p.cancela, chegando) === "true";
  const main = contexto(p.workflow);
  const pr = contexto(p.workflow, { evento: "pull_request", ref: "refs/pull/42/merge", pr: 42 });

  it("uma primeira tentativa nova da main pode substituir a anterior no mesmo job", () => {
    const velha = { ...main, head: "antigo" };
    expect(grupo(main)).toBe(grupo(velha));
    expect(cancela(main, velha)).toBe(true);
  });

  it("reentrada de main antiga não expulsa a nova; reruns do mesmo head dividem grupo", () => {
    const velha = { ...main, head: "antigo", tentativa: "2" };
    expect(grupo(velha)).not.toBe(grupo(main));
    expect(cancela(velha, main)).toBe(false);
    expect(grupo(velha)).not.toBe(grupo({ ...main, tentativa: "2" }));
    expect(grupo(velha)).toBe(grupo({ ...velha, tentativa: "3" }));
    expect(grupo(velha)).toContain("antigo");
  });

  it("PR mantém cancelamento normal e a proteção contra aprovação/rerun do head antigo", () => {
    const velha = { ...pr, head: "antigo" };
    expect(cancela(pr, velha)).toBe(true);
    expect(grupo({ ...velha, tentativa: "2" })).not.toBe(grupo(pr));
    expect(cancela({ ...velha, tentativa: "2" }, pr)).toBe(false);
    expect(grupo({ ...velha, tentativa: "2" })).not.toBe(grupo({ ...pr, tentativa: "2" }));
    expect(grupo({ ...pr, tentativa: "2" })).toBe(grupo({ ...pr, tentativa: "3" }));
  });

  it("fontes, workflows, jobs e pernas independentes não se cancelam", () => {
    expect(cancela({ ...pr, pr: 43, ref: "refs/pull/43/merge" }, pr)).toBe(false);
    expect(cancela(pr, contexto(p.workflow, { ref: "refs/heads/42" }))).toBe(false);
    expect(cancela({ ...main, workflow: `${p.workflow}-outro` }, main)).toBe(false);
    if (job !== "build-and-size") expect(cancela({ ...main, perna: "2" }, main)).toBe(false);
    for (const [outroArquivo, outroJob] of ALVOS) {
      if (outroArquivo === arquivo && outroJob === job) continue;
      const outra = politica(outroArquivo, outroJob);
      expect(grupo(main)).not.toBe(interpolar(outra.grupo, contexto(outra.workflow)).toLowerCase());
    }
    for (const publicacao of [
      "build-and-push",
      "juntar-manifestos",
      "imagem-do-app-sobe",
      "imagens-de-fundo-sobem",
    ]) {
      const outra = politica("publish-image.yml", publicacao);
      expect(grupo(main)).not.toBe(interpolar(outra.grupo, contexto(outra.workflow)).toLowerCase());
    }
  });

  it("tags, dispatch e outras branches nunca ganham cancelamento in-progress", () => {
    for (const alteracao of [
      { ref: "refs/tags/v1.92.0" },
      { ref: "refs/heads/release/v1.92" },
      { evento: "workflow_dispatch" },
    ])
      expect(interpolar(p.cancela, contexto(p.workflow, alteracao))).toBe("false");
    expect(grupo(contexto(p.workflow, { ref: "refs/tags/v1.92.0" }))).not.toBe(grupo(main));
    expect(grupo(contexto(p.workflow, { ref: "refs/tags/v1.93.0" }))).not.toBe(
      grupo(contexto(p.workflow, { ref: "refs/tags/v1.92.0" })),
    );
  });
});

it("verify executa sua asserção real: cancelado/skipped/failure não são prova", () => {
  const linhas = readFileSync(".github/workflows/ci.yml", "utf8").split("\n");
  const inicio = linhas.indexOf("  verify:");
  const run = linhas.findIndex((linha, i) => i > inicio && /^ +run: \|$/.test(linha));
  const primeira = linhas[run + 1];
  if (inicio < 0 || run < 0 || !primeira) throw new Error("Agregador verify ausente.");
  const indent = primeira.length - primeira.trimStart().length;
  const corpo: string[] = [];
  for (const linha of linhas.slice(run + 1)) {
    if (linha.trim() && linha.length - linha.trimStart().length < indent) break;
    corpo.push(linha.slice(indent));
  }
  const script = corpo.join("\n");
  expect(script).toContain("needs.verify-parte.result");
  for (const resultado of ["success", "failure", "skipped", "cancelled"]) {
    const concreto = script.replace(/\$\{\{ needs\.verify-parte\.result \}\}/g, resultado);
    const filho = spawnSync("bash", ["-e", "-c", concreto], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, NODE_ENV: "test" },
      timeout: 5000,
    });
    expect(filho.error).toBeUndefined();
    expect(filho.status === 0).toBe(resultado === "success");
  }
});
