/**
 * O PREÂMBULO DO CI NÃO PODE COMER O ORÇAMENTO DOS TESTES.
 *
 * ## O defeito que este arquivo congela
 *
 * O job `verify` — check OBRIGATÓRIO na branch protection — vinha sendo CANCELADO
 * pelo relógio. Medido em 95 execuções (`gh api .../actions/runs/<id>/jobs`, runs
 * 33831269531..33915100363): 20 canceladas, e as 17 que chegaram a registrar o passo
 * `pnpm/action-setup` têm ≥ 352s NELE. Nenhuma verde passou de 300s no mesmo passo.
 *
 *   passo pnpm/action-setup   min 4s · p50 174s · p90 424s · max 433s
 *   trabalho real (total − esse passo), nas 51 verdes:
 *                             min 354s · p50 550s · p90 594s · MÁXIMO 609s
 *
 * O teto é 900s. A suíte nunca chegou perto: quem estourava era um `npm install`
 * contra registry.npmjs.org escondido dentro do self-installer do `pnpm/action-setup`,
 * sem cache e sem teto. Um gate obrigatório que reprova por RELÓGIO e não por defeito
 * treina todo mundo a ignorar vermelho — e um contribuidor externo (PR #565) viu
 * `verify: FAILURE` sem ter feito nada errado, morrendo no meio do `pnpm test:unit`
 * sem uma linha FAIL e sem o rodapé do vitest.
 *
 * O conserto está em `.github/actions/preparar-node` (o cabeçalho de lá tem o
 * mecanismo e a prova com controle positivo). Este arquivo guarda que ele fica:
 * sem guarda, o próximo job novo nasce com o trio cru de novo, e o próximo aperto
 * de relógio é resolvido subindo o teto — que é trocar vermelho honesto por um CI
 * que engorda sem ninguém ver (a mesma razão escrita no cabeçalho do `e2e.yml`).
 *
 * ## Sem parser YAML, com controle positivo
 *
 * `yaml`/`js-yaml` não estão nas dependências do projeto (js-yaml só como transitiva
 * do eslint). Então regex estreito + um primeiro caso que prova que o instrumento
 * enxerga alguma coisa: sem ele, um regex que parou de casar devolve lista vazia e
 * todas as asserções seguintes passam por vacuidade.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const DIR_WORKFLOWS = join(process.cwd(), ".github/workflows");
const ACTION = join(process.cwd(), ".github/actions/preparar-node/action.yml");

/**
 * O teto de cada job que roda a suíte, com a razão ao lado.
 *
 * Subir um número aqui é decisão consciente e visível em code review — que é
 * justamente o que faltava. O teto é o instrumento que denuncia a suíte crescendo;
 * quem o sobe tem de dizer por que o trabalho real (não o preâmbulo) cresceu.
 */
const TETOS: Record<string, { minutos: number; razao: string }> = {
  "ci.yml::verify": {
    minutos: 15,
    razao: "trabalho real medido: p90 594s, máximo 609s em 51 verdes — folga de ~4m45",
  },
  "ci.yml::invariants": {
    minutos: 20,
    razao: "sobe Postgres e aplica o baseline; trabalho real p90 325s",
  },
};

interface Linha {
  arquivo: string;
  n: number;
  texto: string;
}

function linhasEfetivas(dir: string, arquivos: string[]): Linha[] {
  return arquivos.flatMap((arquivo) =>
    readFileSync(join(dir, arquivo), "utf8")
      .split("\n")
      .map((texto, i) => ({ arquivo, n: i + 1, texto }))
      // Comentário não conta: estes arquivos comentam longamente sobre
      // `pnpm/action-setup` e não pode ser o comentário a satisfazer o gate.
      .filter((l) => !l.texto.trimStart().startsWith("#")),
  );
}

function workflows(): string[] {
  return readdirSync(DIR_WORKFLOWS).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
}

describe("o preâmbulo do CI não come o orçamento dos testes", () => {
  it("o instrumento está vivo: acha os workflows e os usos da action", () => {
    // Controle positivo das três asserções seguintes.
    const arquivos = workflows();
    expect(arquivos.length, "workflows em .github/workflows").toBeGreaterThanOrEqual(4);

    const usos = linhasEfetivas(DIR_WORKFLOWS, arquivos).filter((l) =>
      /uses:\s*\.\/\.github\/actions\/preparar-node\s*$/.test(l.texto),
    );
    expect(usos.length, "pontos que usam ./.github/actions/preparar-node").toBeGreaterThanOrEqual(6);
  });

  it("nenhum workflow instala pnpm por fora da action preparada", () => {
    const crus = linhasEfetivas(DIR_WORKFLOWS, workflows())
      .filter((l) => /uses:\s*pnpm\/action-setup/.test(l.texto))
      .map((l) => `${l.arquivo}:${l.n}`);

    expect(
      crus,
      "trio cru de volta: esse passo já cancelou 17 execuções do `verify` por relógio — use ./.github/actions/preparar-node",
    ).toEqual([]);
  });

  it("todo uso da action carrega o seu teto de tempo", () => {
    const semTeto: string[] = [];
    for (const arquivo of workflows()) {
      const linhas = readFileSync(join(DIR_WORKFLOWS, arquivo), "utf8").split("\n");
      linhas.forEach((texto, i) => {
        if (!/uses:\s*\.\/\.github\/actions\/preparar-node\s*$/.test(texto)) return;
        // O passo vai até a próxima linha que abre outro item de lista (`- `)
        // no mesmo recuo, ou até o fim do arquivo.
        const recuo = texto.length - texto.trimStart().length;
        let fim = linhas.length;
        for (let j = i + 1; j < linhas.length; j++) {
          const l = linhas[j]!;
          if (l.trim() === "") continue;
          const r = l.length - l.trimStart().length;
          if (r <= recuo) {
            fim = j;
            break;
          }
        }
        const corpo = linhas.slice(i + 1, fim).filter((l) => !l.trimStart().startsWith("#"));
        if (!corpo.some((l) => /^\s+timeout-minutes:\s*\d+\s*$/.test(l))) {
          semTeto.push(`${arquivo}:${i + 1}`);
        }
      });
    }

    expect(
      semTeto,
      "uso sem timeout-minutes: sem o cinto, um dia de cache frio volta a consumir o orçamento dos testes",
    ).toEqual([]);
  });

  it("o teto dos jobs que rodam a suíte não sobe sem razão escrita", () => {
    const texto = readFileSync(join(DIR_WORKFLOWS, "ci.yml"), "utf8");
    const achados: Record<string, number> = {};
    const re = /^ {2}([A-Za-z0-9_-]+):\s*$/gm;
    for (const m of texto.matchAll(re)) {
      const corpo = texto.slice(m.index! + m[0].length, m.index! + m[0].length + 400);
      const teto = corpo.match(/^ {4}timeout-minutes:\s*(\d+)\s*$/m);
      if (teto) achados[`ci.yml::${m[1]!}`] = Number(teto[1]);
    }

    // Controle positivo: o regex tem de achar os dois jobs de ci.yml.
    expect(Object.keys(achados).sort(), "jobs de ci.yml com teto declarado").toEqual(
      Object.keys(TETOS).sort(),
    );

    for (const [chave, { minutos, razao }] of Object.entries(TETOS)) {
      expect(
        achados[chave],
        `${chave}: o teto mudou. Subir troca vermelho honesto por CI que engorda em silêncio — razão em vigor: ${razao}`,
      ).toBe(minutos);
    }
  });

  it("a action preparada tira o registry npm do caminho crítico", () => {
    const a = readFileSync(ACTION, "utf8")
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
      .join("\n");

    expect(a, "cache do npm ausente: sem ele o self-installer volta a ir ao registry").toMatch(
      /uses:\s*actions\/cache@v\d[\s\S]*?path:\s*~\/\.npm/,
    );
    expect(a, "sem prefer-offline o cache não é usado: npm revalida no registry").toMatch(
      /npm_config_prefer_offline:\s*['"]?true/,
    );
    expect(a, "a versão do pnpm tem de entrar na chave do cache").toMatch(
      /key:[^\n]*steps\.pino\.outputs\.versao/,
    );
  });
});
