/**
 * OS GATES FIXOS DE PASSAGEM PARA HUMANO SÓ RODAM NO WORKER LEGADO.
 *
 * `lib/ai/handoff/triggers.ts` (G1, G3, G4 jurídico, G4 etapa) é chamado só por
 * `workers/ai-response-worker.ts`, e esse worker não responde desde a v1.17.0
 * (`elegivelParaWorkerLegado()` devolve `false`). O agente publicado roda no
 * agent-engine, que não importa nenhum deles.
 *
 * O defeito que este arquivo pega: a skill `deskcomm-cliente-novo`
 * (`references/nichos.md`) afirmava que o G4 jurídico valia "sempre, sem
 * exceção, antes de qualquer LLM". Era falso para todo agente publicado, e foi
 * esse texto que levou a issue #2097 e o PR #2156 a mexer no worker legado,
 * onde a mudança não alcança ninguém. Nenhuma cerca dizia onde o gate vive.
 *
 * Duas metades:
 *  1. Código: todo `check*` exportado de `triggers.ts` está em `SO_NO_LEGADO`,
 *     e quem o importa fora de teste é exatamente o worker legado. Ligar um
 *     gate no engine (ou em qualquer outro lugar) deixa isto vermelho, e quem
 *     ligou tira o nome da lista e corrige a skill.
 *  2. Skill: parágrafo de `.agents/skills/**` que cita um gate só-legado
 *     precisa dizer "legado". Mede a palavra, não a afirmação; é o mínimo
 *     que obriga quem escreve a encarar onde o gate roda.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { describe, expect, it } from "vitest";

const RAIZ = process.cwd();
const TRIGGERS = "lib/ai/handoff/triggers";
const REGEX = "lib/ai/handoff/regex";
const WORKER_LEGADO = "workers/ai-response-worker.ts";

/** Gate → por que ele não precisa existir no agent-engine. */
const SO_NO_LEGADO: Record<string, string> = {
  checkG1: "o engine tem a própria detecção de pedido de pessoa (detectHumanHandoffRequest)",
  checkG3:
    "limiar de similaridade do RAG do worker legado; sem chamada no engine (equivalente lá não medido)",
  checkG4Legal:
    "o engine não tem passagem fixa por assunto jurídico; quem decide é o modelo (request_human_handoff)",
  checkG4Stage: "etapa `requires_human`: lida só pelo worker legado (o engine não lê a coluna)",
};
/** Constantes de regex.ts que são o próprio gate (não podem vazar por fora de triggers.ts). */
const REGEX_DOS_GATES = ["G1_REGEX", "G4_LEGAL_REGEX"];

function arquivosVersionados(...padroes: string[]): string[] {
  return execFileSync("git", ["ls-files", "--", ...padroes], { cwd: RAIZ, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}

/** Nomes que `arquivo` importa de `modulo` ("*" = o módulo inteiro). */
function importados(arquivo: string, texto: string, modulo: string): string[] {
  const nomes: string[] = [];
  const resolve = (spec: string) =>
    spec.startsWith("@/")
      ? spec.slice(2)
      : spec.startsWith(".")
        ? normalize(join(dirname(arquivo), spec))
        : spec;
  for (const m of texto.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    if (resolve(m[2]!) !== modulo) continue;
    for (const n of m[1]!.split(",")) {
      const nome = n
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)[0]!;
      if (nome) nomes.push(nome);
    }
  }
  for (const m of texto.matchAll(
    /(?:import\s+\*\s+as\s+\w+\s+from|import\s*\()\s*["']([^"']+)["']/g,
  )) {
    if (resolve(m[1]!) === modulo) nomes.push("*");
  }
  return nomes;
}

const producao = arquivosVersionados("*.ts", "*.tsx").filter(
  (f) => !/\.(test|spec)\.tsx?$/.test(f) && !f.startsWith("tests/"),
);
const textos = new Map(producao.map((f) => [f, readFileSync(join(RAIZ, f), "utf8")]));

function quemImporta(modulo: string, nome: string): string[] {
  return producao.filter((f) => {
    const n = importados(f, textos.get(f)!, modulo);
    return n.includes(nome) || n.includes("*");
  });
}

describe("gates fixos de passagem para humano só no worker legado", () => {
  const exportados = [
    ...readFileSync(join(RAIZ, `${TRIGGERS}.ts`), "utf8").matchAll(
      /^export\s+(?:async\s+)?function\s+(check\w+)/gm,
    ),
  ].map((m) => m[1]!);

  it("lê os gates de triggers.ts (controle: a sonda acha algum)", () => {
    expect(exportados).toContain("checkG4Legal");
  });

  it("todo gate exportado está em SO_NO_LEGADO, e a lista não tem nome morto", () => {
    expect([...exportados].sort()).toEqual(Object.keys(SO_NO_LEGADO).sort());
  });

  it.each(Object.keys(SO_NO_LEGADO))("%s é importado só pelo worker legado", (gate) => {
    expect(
      quemImporta(TRIGGERS, gate),
      `${gate} passou a rodar fora do worker legado. Tire-o de SO_NO_LEGADO e corrija ` +
        "a skill (.agents/skills/deskcomm-cliente-novo/references/nichos.md), que diz que ele não vale para o agente publicado.",
    ).toEqual([WORKER_LEGADO]);
  });

  it.each(REGEX_DOS_GATES)("%s só é importado por triggers.ts", (nome) => {
    expect(quemImporta(REGEX, nome)).toEqual([`${TRIGGERS}.ts`]);
  });

  it("parágrafo de skill que cita gate só-legado diz que ele é do legado", () => {
    const nomes = [...Object.keys(SO_NO_LEGADO), ...REGEX_DOS_GATES];
    const semLegado: string[] = [];
    for (const arquivo of arquivosVersionados(".agents/skills")) {
      if (!arquivo.endsWith(".md")) continue;
      const paragrafos = readFileSync(join(RAIZ, arquivo), "utf8").split(/\n\s*\n/);
      for (const p of paragrafos) {
        const citado = nomes.find((n) => new RegExp(`\\b${n}\\b`).test(p));
        if (citado && !/legado/i.test(p)) semLegado.push(`${arquivo}: cita ${citado}`);
      }
    }
    expect(semLegado).toEqual([]);
  });
});
