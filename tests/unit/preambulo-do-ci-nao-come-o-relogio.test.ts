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
  // A suíte foi repartida (issue #1185): o teto vive nas PARTES, e o agregado
  // `verify` não tem teto (mesma razão do `invariants`).
  //
  // A história do número, para ninguém subir de novo sem ler:
  //   - 15 min com a suíte num job só: 13 de 39 rodadas morriam no teto
  //     (mediana 15,2 · melhor sucesso 14,9), chegando como `cancelled`,
  //     indistinguível de cancelamento humano.
  //   - #1184 subiu para 25 como TORNIQUETE (guarda de travamento) e pôs o passo
  //     `Orçamento de tempo do verify` a 16 min para denunciar crescimento — e
  //     escreveu aqui: "QUANDO O #1185 ENTRAR, ESTE NÚMERO DESCE".
  //   - #1190 repartiu (`verify-parte`, `--shard`): o número desceu para 15, e o
  //     orçamento para 12. Medido antes da divisão, num verde do #1190: job
  //     866 s, `Unit tests` 649 s — cada parte roda metade.
  "ci.yml::verify-parte": {
    minutos: 15,
    razao:
      "a suíte foi repartida em partes (#1185 via #1190); cada parte roda metade de uma suíte " +
      "que custava 649s de unit num verde. 15 é guarda de travamento; quem denuncia crescimento " +
      "é o passo `Orçamento de tempo do verify-parte` (12 min por parte, medido em 19/09)",
  },
  // O agregado `invariants` NÃO tem teto de propósito: ele não roda a suíte, só
  // lê o desfecho de `needs`. O teto que denuncia a suíte crescendo vive na perna
  // que a roda.
  "ci.yml::invariants-majors": {
    minutos: 30,
    razao:
      "a perna deixou de ser UMA passada: agora é `test:db` + `test:db:update`, e cada uma sobe " +
      "Postgres e aplica o baseline (p90 medido de uma passada: 325s). O 30 é DECLARADO, não " +
      "medido — não há Docker onde esta matriz foi escrita; mantido em 20, a perna morreria por " +
      "relógio no meio da segunda passada",
  },
};

/**
 * O ORÇAMENTO de cada job que roda a suíte — o número que DENUNCIA crescimento.
 *
 * Existe separado de `TETOS` porque os dois papéis são distintos, e foi a confusão
 * entre eles que produziu o defeito de 18/09: o teto é GUARDA DE TRAVAMENTO (mata
 * job pendurado, e o valor quase não importa); o orçamento é DETECTOR (reprova com
 * mensagem legível, em português, quando a suíte engorda).
 *
 * ⚠️ POR QUE ESTE MAPA NASCEU: o teto tinha catraca — `TETOS`, que cobra razão
 * escrita e versionada — e o companheiro dele NÃO TINHA NADA. Medido em 18/09:
 * subir o `ORCAMENTO_MIN` do `ci.yml` sozinho, sem tocar em mais nada, deixava a
 * suíte inteira verde. Ou seja, qualquer um podia pôr o orçamento ACIMA do teto e
 * o detector viraria enfeite, em silêncio, restaurando exatamente o problema que
 * ele foi criado para resolver. A sabotagem foi refeita em 19/09 contra a régua
 * nova (partes/matrix) e continuava passando antes deste mapa.
 */
const ORCAMENTOS: Record<string, { minutos: number; razao: string }> = {
  // UMA entrada cobre as DUAS partes: o `ORCAMENTO_MIN` vive no `env:` de um
  // passo único dentro da `matrix`, então as duas partes leem o mesmo número.
  // Que o passo não fique preso a uma delas é o que o caso
  // "o orçamento vale para as DUAS partes" abaixo guarda.
  "ci.yml::verify-parte": {
    minutos: 12,
    razao:
      "MEDIDO em 19/09/2026 sobre todos os jobs `verify-parte` das 240 rodadas completas de " +
      "ci.yml criadas depois de as partes entrarem na main (18/09 18:37Z): n=286 que EXECUTARAM " +
      "(260 success + 26 failure) — min 0,9 · mediana 7,2 · p90 8,6 · p95 8,8 · MÁX 9,6; ZERO " +
      "acima de 10. Parte 1/2 (cercas+typecheck+lint) mediana 8,3 · máx 9,6; parte 2/2 (kit " +
      "bash) mediana 7,0 · máx 7,5. O 12 é máx+2,4, com 3 min até o teto de 15 — o detector " +
      "dispara ANTES do corte, que é o que faz chegar `::error::` legível em vez de `cancelled` " +
      "mudo. Os 100 `cancelled` do intervalo foram CLASSIFICADOS, não descartados em silêncio: " +
      "87 com zero passos (morreram na fila de runner, nunca rodaram) e 13 cortados por push " +
      "novo, o mais longo com 6,5 min — NENHUM morreu no teto, então a amostra não é censurada. " +
      "⚠️ LIÇÃO DE MÉTODO, que vale mais que o número: teto e orçamento CENSURAM a medição que " +
      "os calibra. Os valores anteriores deste campo (16, depois 19) saíram de `pior sucesso " +
      "14,9` medido sob um teto de 15, e sob aquele teto o job que passaria de 15 morria e " +
      "entrava em `cancelled`, não em `success` — era a distribuição dos SOBREVIVENTES tratada " +
      "como a distribuição dos jobs. Depois de mexer em qualquer um dos dois, ESPERE a " +
      "distribuição nova, CLASSIFIQUE os `cancelled` e só então recalibre — nunca antes",
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

  it("o orçamento declarado no ci.yml é o do mapa (catraca anti-deriva)", () => {
    const texto = readFileSync(join(DIR_WORKFLOWS, "ci.yml"), "utf8");
    const achados: Record<string, number> = {};
    // O orçamento vive no `env:` do passo, então a âncora é o nome do passo — que
    // nomeia o JOB guardado (`verify-parte`), para a chave bater com a de `TETOS`
    // e o invariante "orçamento < teto" ser uma consulta direta. O hífen precisa
    // entrar na classe: `\w` não o casa, e regex que deixa de casar é o modo de
    // falha que o controle de vivacidade abaixo existe para pegar.
    const re = /name: Orçamento de tempo do ([\w-]+)\n(?:.*\n)*?\s+ORCAMENTO_MIN: "(\d+)"/g;
    for (const m of texto.matchAll(re)) achados[`ci.yml::${m[1]!}`] = Number(m[2]!);

    // Controle de VIVACIDADE: sem ele, um regex que deixasse de casar daria verde
    // por vacuidade — é o modo de falha que derrubou duas entregas em 18/09.
    expect(
      Object.keys(achados).sort(),
      "nenhum ORCAMENTO_MIN encontrado no ci.yml — o passo mudou de nome e esta catraca cegou",
    ).toEqual(Object.keys(ORCAMENTOS).sort());

    for (const [chave, { minutos, razao }] of Object.entries(ORCAMENTOS)) {
      expect(
        achados[chave],
        `${chave}: o orçamento mudou. Ele é o DETECTOR de crescimento — razão em vigor: ${razao}`,
      ).toBe(minutos);
    }
  });

  it("o orçamento vale para as DUAS partes da matrix, não só para uma", () => {
    // `verify-parte` é uma `matrix` de 2, e o `ORCAMENTO_MIN` vive num passo
    // ÚNICO que as duas partes executam. Os passos vizinhos (`Cercas`,
    // `Typecheck`, `Lint`, `Kit self-host`) são todos `if: matrix.parte == N` —
    // então pôr um `if:` de parte neste aqui é uma edição de uma linha, natural
    // de fazer por simetria, e deixaria metade da suíte sem detector nenhum.
    const linhas = readFileSync(join(DIR_WORKFLOWS, "ci.yml"), "utf8").split("\n");
    const i = linhas.findIndex((l) => /^\s+- name: Orçamento de tempo do [\w-]+\s*$/.test(l));

    // Controle de VIVACIDADE: sem ele, o passo renomeado sumiria da busca e as
    // asserções abaixo passariam por vacuidade.
    expect(i, "o passo do orçamento não foi encontrado no ci.yml — esta guarda cegou").toBeGreaterThanOrEqual(0);

    const recuo = linhas[i]!.length - linhas[i]!.trimStart().length;
    let fim = linhas.length;
    for (let j = i + 1; j < linhas.length; j++) {
      const l = linhas[j]!;
      if (l.trim() === "") continue;
      if (l.length - l.trimStart().length <= recuo) {
        fim = j;
        break;
      }
    }
    const corpo = linhas.slice(i, fim).filter((l) => !l.trimStart().startsWith("#"));

    expect(
      corpo.some((l) => /^\s+ORCAMENTO_MIN:/.test(l)),
      "o ORCAMENTO_MIN saiu deste passo — a busca por nome deixou de encontrar o número",
    ).toBe(true);

    const condicoes = corpo.filter((l) => /^\s+if:/.test(l)).map((l) => l.trim());
    expect(
      condicoes.filter((c) => c.includes("matrix")),
      "o passo do orçamento ficou preso a uma parte da matrix: a outra roda sem detector de crescimento",
    ).toEqual([]);
  });

  it("o orçamento é MENOR que o teto — senão o detector nunca dispara", () => {
    // O invariante que importa mais que os dois números: se o orçamento passar do
    // teto, o job morre de relógio ANTES de o passo de orçamento rodar, e o sinal
    // volta a ser `cancelled` — indistinguível de cancelamento humano. O detector
    // existiria e nunca falaria.
    for (const [chave, { minutos }] of Object.entries(ORCAMENTOS)) {
      const teto = TETOS[chave]?.minutos;
      expect(teto, `${chave}: há orçamento declarado e nenhum teto para comparar`).toBeDefined();
      expect(
        minutos,
        `${chave}: orçamento ${minutos} >= teto ${teto}. O job morre no teto antes de o ` +
          "orçamento rodar, e o vermelho volta a chegar como `cancelled`.",
      ).toBeLessThan(teto!);
    }
  });

  it("a divisão do verify cobre cada arquivo uma vez: --shard e `if:` batem com a matrix", () => {
    // Mexer na divisão (reequilibrar passos, criar a parte 3) tem dois erros
    // VERDES: `--shard=N/3` com matrix [1, 2] deixa um terço da suíte sem rodar,
    // e `if: matrix.parte == 3` com matrix [1, 2] deixa o passo sem parte.
    // Que o `--shard` do vitest corta em fatias disjuntas que somam tudo foi
    // provado com o sequenciador dele no PR que moveu o lint (1108 = 554 + 554).
    const texto = readFileSync(join(DIR_WORKFLOWS, "ci.yml"), "utf8");
    const inicio = texto.indexOf("\n  verify-parte:\n");
    expect(inicio, "o job verify-parte sumiu do ci.yml — esta guarda cegou").toBeGreaterThan(-1);
    const resto = texto.slice(inicio + 1);
    const fim = resto.slice(1).search(/\n {2}[\w-]+:\n/);
    const job = (fim === -1 ? resto : resto.slice(0, fim + 1))
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
      .join("\n");

    const partes = job.match(/^\s+parte: \[([\d, ]+)\]\s*$/m)?.[1]?.split(",").map(Number);
    expect(partes, "a matrix `parte: [...]` não foi encontrada").toBeDefined();
    expect(partes, "as partes têm de ser 1..N, sem buraco").toEqual(partes!.map((_, i) => i + 1));

    const shards = [...job.matchAll(/--shard=\$\{\{ matrix\.parte \}\}\/(\d+)/g)].map((m) => Number(m[1]));
    expect(shards, "o passo de unit tem de recortar com --shard=${{ matrix.parte }}/N").toEqual([partes!.length]);

    const alvos = [...job.matchAll(/matrix\.parte == (\d+)/g)].map((m) => Number(m[1]));
    expect(alvos.length, "nenhum `if: matrix.parte == N` — o regex cegou").toBeGreaterThan(0);
    expect(alvos.filter((n) => !partes!.includes(n)), "passo preso a uma parte que não existe").toEqual([]);
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
