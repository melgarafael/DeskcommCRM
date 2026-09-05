/**
 * A ACOLHIDA AUTOMÁTICA NÃO PODE ENCOSTAR NO CÓDIGO DE QUEM ABRIU O PR.
 *
 * ## O que está sendo vigiado, e por que este arquivo existe
 *
 * `.github/workflows/acolhida.yml` roda em `pull_request_target`. Esse gatilho é a
 * única maneira de comentar num PR de fork — o `GITHUB_TOKEN` de `pull_request` em
 * fork é read-only — e ele vem com o preço: o job roda no contexto da BASE, com os
 * SEGREDOS do repositório e com permissão de escrita, disparado por quem é de fora.
 *
 * Todo o desenho daquele arquivo é uma única aposta: o job não encosta em NADA que
 * venha do PR. As quatro propriedades abaixo são essa aposta escrita como gate.
 * Nenhuma delas é opinião de estilo — cada uma corresponde a um caminho publicado
 * de escalada em `pull_request_target`:
 *
 *   1. ZERO `uses:` (⇒ zero `actions/checkout`) e zero chave `ref:`. Um checkout com
 *      `ref: github.event.pull_request.head.sha` põe a árvore do fork no runner que
 *      já tem os segredos; a partir daí qualquer `npm install`, script de
 *      `package.json` ou action local do fork executa com eles à mão.
 *   2. `permissions` é EXATAMENTE `pull-requests: write`. Declarar o bloco zera todo
 *      escopo não citado. `contents: write` aqui daria commit na `main` a um evento
 *      disparado por terceiro; `actions: write` daria aprovar e re-executar workflow.
 *   3. NENHUM `${{ }}` dentro de `run:`. Título, corpo e nome de branch são texto
 *      escolhido pelo autor do PR, e a interpolação acontece ANTES de o shell
 *      existir: `${{ github.event.pull_request.title }}` num `run:` é execução de
 *      comando, não leitura de string. A asserção é sobre a linha CRUA, comentário
 *      de shell incluído — o Actions interpola lá também.
 *   4. O gatilho é só `opened`. `synchronize`/`reopened` fariam a acolhida chegar a
 *      cada push, e ampliariam a janela em que um workflow privilegiado dispara.
 *
 * ## O instrumento, e por que ele começa por um controle positivo
 *
 * Não há parser YAML nas dependências (`yaml`/`js-yaml` não estão em `dependencies`
 * nem `devDependencies` — js-yaml só existe como transitiva do eslint, e depender de
 * transitiva é dívida): a mesma constatação de `tests/unit/workflows-tem-permissions.test.ts`
 * e `tests/unit/gatilho-dos-jobs-de-entrega.test.ts`. Então: recorte por indentação
 * + CONTROLE POSITIVO. Sem o controle, um recorte que parou de casar devolve lista
 * vazia, "nenhum `${{ }}` em `run:`" fica verde por vacuidade, e o gate vigia nada.
 *
 * ## O que ele NÃO prova
 *
 * Nada aqui executa o workflow. Que o `gh api` responda, que o token com
 * `pull-requests: write` consiga comentar, e que o `if:` de fork case como escrito —
 * isso só a primeira execução real prova. O que este arquivo garante é que as
 * propriedades de segurança do desenho não sejam apagadas por uma edição futura.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ARQUIVO = join(process.cwd(), ".github/workflows/acolhida.yml");
const LINHAS = readFileSync(ARQUIVO, "utf8").split("\n");

/**
 * Linhas com o comentário YAML zerado, preservando a numeração.
 *
 * Vale para as asserções de ESTRUTURA: o cabeçalho daquele arquivo explica por
 * escrito o que ele não faz, e cita `actions/checkout`, `actions: write` e
 * `${{ }}`. Um `#` não pode reprovar o gate — nem satisfazê-lo.
 */
const EFETIVAS = LINHAS.map((l) => (l.trimStart().startsWith("#") ? "" : l));

const recuo = (l: string) => l.length - l.trimStart().length;

/**
 * O conteúdo CRU de cada `run:`, comentário de shell incluído.
 *
 * Cru de propósito: o Actions substitui `${{ }}` no texto inteiro do script antes
 * de entregá-lo ao shell, então um `${{ }}` dentro de um `# comentário` do bash é
 * exatamente tão executável quanto um fora dele.
 */
function blocosRun(): { linha: number; conteudo: string[] }[] {
  const blocos: { linha: number; conteudo: string[] }[] = [];

  for (let i = 0; i < EFETIVAS.length; i++) {
    const m = EFETIVAS[i]!.match(/^(\s*)(?:- )?run:(.*)$/);
    if (!m) continue;

    const dentro = recuo(EFETIVAS[i]!);
    const resto = m[2]!.trim();

    // `run: comando` numa linha só — o conteúdo é o próprio resto.
    if (resto !== "" && !/^[|>][-+]?$/.test(resto)) {
      blocos.push({ linha: i + 1, conteudo: [resto] });
      continue;
    }

    // Escalar de bloco: vai até a próxima linha não-vazia com recuo <= o da chave.
    const conteudo: string[] = [];
    for (let j = i + 1; j < LINHAS.length; j++) {
      const bruta = LINHAS[j]!;
      if (bruta.trim() === "") {
        conteudo.push(bruta);
        continue;
      }
      if (recuo(bruta) <= dentro) break;
      conteudo.push(bruta);
    }
    blocos.push({ linha: i + 1, conteudo });
  }

  return blocos;
}

/** As linhas do mapeamento aberto por `chave:` na coluna `col`, uma por entrada. */
function mapeamento(chave: string, col: number): string[] {
  const i = EFETIVAS.findIndex((l) => new RegExp(`^ {${col}}${chave}:\\s*$`).test(l));
  if (i === -1) return [];
  const dentro: string[] = [];
  for (let j = i + 1; j < EFETIVAS.length; j++) {
    const l = EFETIVAS[j]!;
    if (l.trim() === "") continue;
    if (recuo(l) <= col) break;
    dentro.push(l.trim());
  }
  return dentro;
}

const runs = blocosRun();
const textoDosRuns = runs.flatMap((b) => b.conteudo).join("\n");

describe("acolhida: um workflow privilegiado que não toca no código do fork", () => {
  it("o instrumento está vivo: acha o job, o `run:` e as interpolações do arquivo", () => {
    // Controle positivo das quatro asserções seguintes. Sem ele, um recorte que
    // parou de casar devolve lista vazia e tudo passa por vacuidade — o modo de
    // falha mais comum desta classe de teste.
    expect(LINHAS.length, "linhas lidas de acolhida.yml").toBeGreaterThan(50);
    expect(runs.length, "blocos `run:` recortados").toBe(1);
    expect(runs[0]!.conteudo.length, "linhas dentro do `run:`").toBeGreaterThan(20);
    // E o recorte de `${{ }}` enxerga alguma coisa: o arquivo TEM interpolação —
    // ela vive em `env:`, que é o lugar seguro. Se nem essa fosse vista, a
    // asserção "nenhuma em `run:`" não estaria medindo nada.
    const emEnv = mapeamento("env", 8).filter((l) => l.includes("${{"));
    expect(emEnv.length, "interpolações lidas no bloco `env:` do passo").toBeGreaterThanOrEqual(4);
  });

  it("não baixa uma linha de código: nenhum `uses:`, nenhum `ref:`", () => {
    const usos = EFETIVAS.map((l, i) => ({ l, i }))
      .filter(({ l }) => /^\s*(?:- )?uses:/.test(l))
      .map(({ i }) => `acolhida.yml:${i + 1} — ${LINHAS[i]!.trim()}`);

    expect(
      usos,
      [
        "Este job roda em `pull_request_target`: contexto da base, com segredos e escrita.",
        "Ele não pode baixar NADA — nem `actions/checkout` (que traria a árvore do fork),",
        "nem action de terceiro (que roda com o mesmo token). Zero `uses:` é a aposta inteira.",
      ].join("\n"),
    ).toEqual([]);

    const refs = EFETIVAS.map((l, i) => ({ l, i }))
      .filter(({ l }) => /^\s*ref:/.test(l))
      .map(({ i }) => `acolhida.yml:${i + 1}`);
    expect(refs, "`ref:` é a chave que aponta um checkout para o código do PR").toEqual([]);

    const cabecaDoPr = EFETIVAS.map((l, i) => ({ l, i }))
      .filter(({ l }) => /pull_request\.head\.(sha|ref)\b/.test(l))
      .map(({ i }) => `acolhida.yml:${i + 1}`);
    // `head.repo.full_name` PODE aparecer — é a comparação que detecta fork, e
    // comparar não é buscar. `head.sha`/`head.ref` só servem para ir buscar.
    expect(cabecaDoPr, "`head.sha`/`head.ref` só existem para ir buscar o código do PR").toEqual(
      [],
    );
  });

  it("a permissão é exatamente `pull-requests: write` — nada mais", () => {
    const blocos = EFETIVAS.map((l, i) => ({ l, i })).filter(({ l }) => /^\s*permissions:/.test(l));
    expect(blocos.length, "há exatamente um bloco `permissions:` (no topo do arquivo)").toBe(1);
    expect(recuo(blocos[0]!.l), "o bloco fica no topo: job novo neste arquivo nasce restrito").toBe(
      0,
    );

    expect(
      mapeamento("permissions", 0),
      [
        "O escopo deste token mudou. Declarar o bloco zera tudo que não está citado —",
        "então cada linha aqui é um privilégio novo dado a um evento que QUEM É DE FORA",
        "dispara. `contents: write` = commit na main; `actions: write` = aprovar e",
        "re-executar workflow. A acolhida só precisa comentar.",
      ].join("\n"),
    ).toEqual(["pull-requests: write"]);
  });

  it("nenhum dado do PR entra em `run:` — nem dentro de comentário de shell", () => {
    const interpoladas = runs.flatMap((b) =>
      b.conteudo
        .map((l, k) => ({ l, k }))
        .filter(({ l }) => l.includes("${{"))
        .map(({ l, k }) => `acolhida.yml:${b.linha + 1 + k} — ${l.trim()}`),
    );

    expect(
      interpoladas,
      [
        "`${{ }}` dentro de `run:` é substituição de TEXTO feita antes de o shell existir:",
        "o valor vira código-fonte do script. Título, corpo e branch do PR são escolhidos",
        "por quem o abriu. O caminho seguro é `env:` + citação com aspas — que é o que",
        "este workflow faz com o login. Comentário de shell conta: o Actions interpola lá também.",
      ].join("\n"),
    ).toEqual([]);
  });

  it("dispara só em `opened`, e só em `pull_request_target`", () => {
    expect(mapeamento("on", 0)).toEqual(["pull_request_target:", "types: [opened]"]);
  });

  it("só acolhe PR de fork, e não fala pelos forks deste repositório", () => {
    const condicao = EFETIVAS.filter((l) => /^ {4}if:/.test(l)).join("");
    expect(condicao).toContain(
      "github.event.pull_request.head.repo.full_name != github.repository",
    );
    // Este arquivo vai para a `main` de um produto self-host: sem a guarda de dono,
    // o fork de cada pessoa herda um bot que fala pela gente no repositório dela.
    expect(condicao).toContain("github.repository_owner == 'melgarafael'");
  });

  it("lê os comentários e desiste se a conversa já começou — ANTES de postar", () => {
    const conteudo = runs[0]!.conteudo;
    const iLeitura = conteudo.findIndex((l) => /gh api .*\/comments/.test(l));
    const iAncora = conteudo.findIndex((l) => /grep -qF 'triagem-de-pr:v1:'/.test(l));
    const iPost = conteudo.findIndex((l) => /--method POST/.test(l));

    expect(iLeitura, "o job lista os comentários existentes").toBeGreaterThanOrEqual(0);
    expect(iAncora, "o job procura a âncora da triagem").toBeGreaterThanOrEqual(0);
    expect(iPost, "o job posta o comentário").toBeGreaterThanOrEqual(0);

    // A ordem é a propriedade — ter as três chamadas não diz nada se o POST vier
    // primeiro. Um humano pode ter acolhido (ou já ter dado o veredito) antes.
    expect(iLeitura, "listar vem antes de procurar a âncora").toBeLessThan(iAncora);
    expect(iAncora, "procurar a âncora vem antes de postar").toBeLessThan(iPost);

    // E a âncora postada é a canônica da triagem — é ela que a própria releitura
    // encontra na próxima execução, e é ela que um mantenedor reconhece.
    expect(textoDosRuns).toContain("<!-- triagem-de-pr:v1:pass=1 -->");
  });

  it("a mensagem continua dizendo as três coisas, e nenhuma delas avalia o PR", () => {
    // O molde é `triagem/references/resposta-ao-contribuidor.md`, seção "Acolhida".
    // A acolhida é segura de ser automática porque não fala do mérito; se alguém
    // esvaziar o texto, ela deixa de fazer o trabalho pelo qual existe.
    expect(textoDosRuns, "o Vercel vermelho não é culpa de quem abriu o PR").toMatch(
      /Vercel[\s\S]*gate de merge/,
    );
    expect(textoDosRuns, "os workflows podem estar parados esperando liberação").toMatch(
      /esperando[\s\S]*?libera/,
    );
    expect(textoDosRuns, "e quando vem o veredito — a promessa que este arquivo faz").toContain(
      "um dia útil",
    );
  });
});
