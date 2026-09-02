import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * A GUARDA DA RELEASE, MEDIDA CONTRA A FORMA DO CORTE.
 *
 * ═══ O defeito que este teste existe para não ter de novo ═══════════════════
 *
 * A v1.11.1 foi anunciada no CHANGELOG e NUNCA virou tag (issue #472). Sem tag:
 * sem release, sem as três imagens, sem `stable` — nenhuma VPS a recebeu. E o
 * workflow saiu `success`: ele apenas decidiu não cortar.
 *
 * A guarda antiga reconhecia um corte por "o diretório `.changes/` ficou
 * vazio". No run 33494815423 ela viu `antes=4 depois=1` e desistiu — porque o
 * PR #460 mergeou ENTRE o corte e o merge da release, deixando o fragmento
 * dele vivo. Merge comum correndo em paralelo com a release é o estado normal
 * de um repo vivo, não uma anomalia.
 *
 * ═══ Por que este teste EXECUTA o bash do workflow ══════════════════════════
 *
 * Reescrever a regra em TypeScript criaria a segunda verdade sobre o que é um
 * corte, e a segunda envelhece sozinha: alguém ajusta o YAML, o espelho de TS
 * segue verde, e o gate passa a medir uma regra que não roda em lugar nenhum.
 * Aqui o bloco `run:` é EXTRAÍDO do `.github/workflows/release.yml` e
 * executado — o que está sob teste é o arquivo que o CI usa.
 *
 * ═══ Por que repositório SINTÉTICO, e não os commits reais ══════════════════
 *
 * A primeira versão deste teste julgava SHAs desta `main` — inclusive o
 * `f6f91377` que falhou de verdade. Era evidência melhor de ler e PIOR de
 * confiar: o checkout do CI é raso, e lá o teste devolvia
 *
 *     fatal: bad revision '1e3c724f^'
 *
 * em todos os casos. Um gate que só mede na máquina de quem o escreveu é pior
 * que gate nenhum, porque parece cobertura.
 *
 * O repositório abaixo REPRODUZ a forma do #472 em vez de depender de ela ter
 * acontecido: dois fragmentos, um branch de release que os apaga assinado pelo
 * bot, um PR concorrente que acrescenta um terceiro no meio, e o merge com dois
 * pais. Roda igual em qualquer clone, raso ou completo.
 */

const RAIZ = process.cwd();
const BOT = "deskcomm-release[bot]";

/** O bloco `run:` do passo que decide se este push foi um corte. */
function bashDaGuarda(): string {
  const yml = readFileSync(join(RAIZ, ".github/workflows/release.yml"), "utf8");
  const inicio = yml.indexOf("Este push foi um corte de release?");
  expect(inicio, "o passo da guarda sumiu do release.yml").toBeGreaterThan(-1);
  const run = yml.indexOf("run: |", inicio);
  expect(run, "o passo da guarda não tem bloco run").toBeGreaterThan(-1);

  const linhas = yml.slice(run + "run: |".length).split("\n").slice(1);
  const corpo: string[] = [];
  for (const l of linhas) {
    // O bloco acaba na primeira linha não-vazia com indentação menor que a dele.
    if (l.trim() !== "" && !l.startsWith("          ")) break;
    corpo.push(l.slice(10));
  }
  return corpo.join("\n");
}

let repo: string;

function git(args: string[], opts: { autor?: string } = {}): string {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  if (opts.autor) {
    Object.assign(env, {
      GIT_AUTHOR_NAME: opts.autor,
      GIT_COMMITTER_NAME: opts.autor,
      GIT_AUTHOR_EMAIL: `${opts.autor}@exemplo.test`,
      GIT_COMMITTER_EMAIL: `${opts.autor}@exemplo.test`,
    });
  }
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", env }).trim();
}

function fragmento(nome: string, impacto = "nada_mudou") {
  mkdirSync(join(repo, ".changes"), { recursive: true });
  writeFileSync(
    join(repo, ".changes", nome),
    `---\nimpacto: ${impacto}\nsecao: corrigido\ntitulo: ${nome}\n---\n\ncorpo.\n`,
  );
}

function commit(mensagem: string, autor = "Alguém do time") {
  git(["add", "-A"]);
  git(["commit", "-q", "-m", mensagem], { autor });
  return git(["rev-parse", "HEAD"]);
}

/**
 * Roda a guarda como se `HEAD` fosse `sha`, dentro do repositório sintético.
 *
 * `HEAD^2` primeiro, depois `HEAD^`, depois `HEAD`: a ordem importa, senão
 * `HEAD^2` viraria `<sha>^2` só pela metade.
 */
function decisaoPara(sha: string): string {
  const original = bashDaGuarda();

  // A versão vem do CHANGELOG por um script de TS que não existe no repo
  // sintético; ela é irrelevante aqui e fica num número sem tag, para não sair
  // pelo primeiro `if`.
  //
  // ⚠️ `[^\n]*` e não `.*$`: com `$` e a flag `m`, um `\r` de fim de linha faz
  // a âncora não casar, a substituição vira NO-OP SILENCIOSA, e o script tenta
  // rodar `pnpm exec tsx` dentro do repositório temporário — que não tem
  // `scripts/`. O sintoma é um `Command failed` sem explicação, e foi assim que
  // este teste passou na minha máquina e reprovou no CI.
  const script = original
    .replace(/^[ \t]*versao=\$\([^\n]*\)[ \t\r]*$/m, 'versao="999.999.999"')
    .replace(/HEAD\^2/g, `${sha}^2`)
    .replace(/HEAD\^/g, `${sha}^`)
    .replace(/\bHEAD\b/g, sha);

  // A substituição que não acontece tem de gritar, não sumir.
  expect(script, "a linha `versao=$(...)` não foi substituída — o script rodaria o cortar-release de verdade")
    .not.toMatch(/cortar-release\.ts/);

  // ⚠️ `GITHUB_OUTPUT` vai para um ARQUIVO, não para `/dev/stdout`.
  //
  // Isto foi o que reprovou este teste no CI enquanto ele passava aqui, e a
  // causa não era nenhuma das duas que eu e o Maestro supusemos (fim de linha,
  // interação entre testes). O stderr, quando finalmente chegou ao log, disse
  // em uma linha:
  //
  //     bash: line 109: /dev/stdout: No such device or address
  //
  // No runner, o stdout do processo é um pipe capturado pelo `execFileSync`, e
  // `>> /dev/stdout` falha. No macOS funciona. O passo do workflow escreve no
  // arquivo que o GitHub dá — então o teste faz o mesmo, que é também o que o
  // ambiente real faz.
  const saidaDoGithub = join(repo, `.github-output-${process.pid}`);
  writeFileSync(saidaDoGithub, "");

  try {
    const saida = execFileSync("bash", ["-c", script], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, GITHUB_OUTPUT: saidaDoGithub },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const escrito = readFileSync(saidaDoGithub, "utf8");
    return /cortar=(\w+)/.exec(`${escrito}\n${saida}`)?.[1] ?? "(nenhuma decisão)";
  } catch (err) {
    // `execFileSync` joga fora o stderr na mensagem padrão, e sem ele o CI
    // devolve só "Command failed: bash -c set -euo pipefail". Diagnóstico que
    // não chega ao log é diagnóstico que não existe.
    const e = err as { stderr?: Buffer | string; stdout?: Buffer | string; status?: number };
    const detalhe = [
      `exit=${e.status ?? "?"}`,
      `stderr: ${String(e.stderr ?? "").trim() || "(vazio)"}`,
      `stdout: ${String(e.stdout ?? "").trim() || "(vazio)"}`,
    ].join("\n");
    throw new Error(`a guarda derrubou o passo para ${sha}\n${detalhe}`);
  }
}

/**
 * Roda a guarda esperando que ela RECUSE, e devolve o que ela disse.
 *
 * ⚠️ Existe porque `expect(...).toThrow()` sozinho é VÁCUO: qualquer coisa que
 * derrube o bash faz o caso passar. Foi exatamente o que aconteceu por dois
 * runs seguidos — o `/dev/stdout` matava o script antes de a guarda decidir, e
 * os casos de recusa passavam pelo motivo errado enquanto os de decisão
 * falhavam. Um teste que aceita qualquer falha não distingue a guarda
 * funcionando da guarda quebrada.
 */
function recusaPara(sha: string): { status: number; saida: string } {
  try {
    decisaoPara(sha);
  } catch (err) {
    const m = /exit=(\d+)/.exec(String((err as Error).message));
    return { status: Number(m?.[1] ?? -1), saida: String((err as Error).message) };
  }
  throw new Error(`a guarda NÃO recusou ${sha} — ela decidiu, quando devia ter derrubado o passo`);
}

let mergeDaReleaseComCorrida = "";
let mergeDePrComum = "";
let commitDeFeature = "";

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "guarda-release-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.name", "Alguém do time"]);
  git(["config", "user.email", "alguem@exemplo.test"]);
  git(["config", "commit.gpgsign", "false"]);

  writeFileSync(join(repo, "CHANGELOG.md"), "# Changelog\n");
  mkdirSync(join(repo, ".changes"), { recursive: true });
  writeFileSync(join(repo, ".changes/.gitkeep"), "");
  commit("chore: raiz");

  // ── Estado antes do corte: dois fragmentos declarados ────────────────────
  fragmento("a.md");
  fragmento("b.md");
  const antesDoCorte = commit("feat: dois fragmentos");

  // ── O branch de release: apaga o que consumiu, assinado pelo App ─────────
  git(["checkout", "-q", "-b", "release/9.9.9", antesDoCorte]);
  rmSync(join(repo, ".changes/a.md"));
  rmSync(join(repo, ".changes/b.md"));
  writeFileSync(join(repo, "CHANGELOG.md"), "# Changelog\n\n## [9.9.9]\n");
  const pontaDaRelease = commit("release(9.9.9): a versão montada a partir dos fragmentos", BOT);

  // ── A CORRIDA: um PR comum mergeia na main enquanto a release espera ─────
  git(["checkout", "-q", "main"]);
  fragmento("c.md");
  const prConcorrente = commit("feat: o PR que chegou no meio");
  git(["merge", "-q", "--no-ff", "-m", "Merge PR #460", prConcorrente]);
  mergeDePrComum = git(["rev-parse", "HEAD"]);

  // ── O merge da release, com o fragmento do concorrente ainda vivo ────────
  git(["merge", "-q", "--no-ff", "-m", "Merge pull request #461 from release/9.9.9", pontaDaRelease]);
  mergeDaReleaseComCorrida = git(["rev-parse", "HEAD"]);

  // ── Um commit qualquer de feature, que não encosta em .changes/ ──────────
  writeFileSync(join(repo, "README.md"), "nada a ver com release\n");
  commitDeFeature = commit("fix: coisa nenhuma");
});

afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

describe("a guarda reconhece o corte pela forma dele", () => {
  it("CORTA o merge de release que correu junto com um PR comum — a forma exata da #472", () => {
    // A guarda antiga via `depois=1` aqui (o fragmento do concorrente) e
    // desistia. É o caso que a v1.11.1 encontrou, e o único que muda.
    expect(decisaoPara(mergeDaReleaseComCorrida)).toBe("sim");
  });

  it("o diretório NÃO fica vazio nesse merge — é o que enganava a guarda antiga", () => {
    // Sem este caso, o anterior poderia estar passando por um cenário onde a
    // regra velha também funcionaria, e o teste não provaria nada.
    const sobraram = git([
      "ls-tree", "-r", "--name-only", mergeDaReleaseComCorrida, "--", ".changes/",
    ])
      .split("\n")
      .filter((l) => l.endsWith(".md"));
    expect(sobraram).toEqual([".changes/c.md"]);
  });

  it("NÃO corta um merge de PR comum, que só acrescenta fragmento", () => {
    expect(decisaoPara(mergeDePrComum)).toBe("nao");
  });

  it("NÃO corta um commit que nem toca em .changes/", () => {
    expect(decisaoPara(commitDeFeature)).toBe("nao");
  });
});

describe("o que SOBRA da release também decide — e foi um cético que achou isto", () => {
  /**
   * A guarda antiga garantia, sem dizer, uma segunda propriedade: `depois==0`
   * significava que a versão anunciada dá conta de TUDO que estava pendente na
   * main. Trocar "esvaziou" por "removeu" abre mão disso — e há um caso em que
   * abrir mão FAZ DANO.
   *
   * O caso: um PR com `impacto: exige_acao` mergeia durante a janela da
   * release. A tag sai, `stable` passa a apontar para uma main que EXIGE ação
   * do operador, e a seção do CHANGELOG que ele lê antes de rodar o `update.sh`
   * diz que nada mudou. O aviso fica na gaveta e o contêiner não sobe.
   *
   * Eu tinha escrito no PR que a guarda nova era "mais forte, não mais fraca".
   * Era falso nesta dimensão, e quem mostrou foi um cético que eu mesmo pus
   * para tentar quebrá-la.
   */
  it("RECUSA ALTO quando sobra fragmento que exige ação do operador", () => {
    git(["checkout", "-q", "main"]);
    fragmento("e-obrigatorio.md", "exige_acao");
    const concorrenteQueQuebra = commit("feat: agora o Redis é obrigatório");
    git(["merge", "-q", "--no-ff", "-m", "Merge PR #999", concorrenteQueQuebra]);

    fragmento("f.md");
    const antes = commit("feat: mais um fragmento para a release consumir");
    git(["checkout", "-q", "-b", "release/8.8.8", antes]);
    rmSync(join(repo, ".changes/f.md"));
    const ponta = commit("release(8.8.8): montada dos fragmentos", BOT);
    git(["checkout", "-q", "main"]);
    git(["merge", "-q", "--no-ff", "-m", "Merge pull request #1000 from release/8.8.8", ponta]);

    const r = recusaPara(git(["rev-parse", "HEAD"]));
    expect(r.status, "a guarda tem de sair com 1, e não morrer por outro motivo").toBe(1);
    expect(r.saida).toMatch(/exige_acao/);
    expect(r.saida).toMatch(/e-obrigatorio\.md/);
  });

  it("CORTA quando o que sobra é inofensivo (controle positivo)", () => {
    // Sem este caso, "recusa sempre que sobra alguma coisa" satisfaria o
    // anterior — e seria a guarda antiga de volta, com outro nome.
    git(["checkout", "-q", "main"]);
    rmSync(join(repo, ".changes/e-obrigatorio.md"));
    commit("chore: some com o fragmento que exige ação");

    fragmento("g.md", "capacidade_nova");
    fragmento("h.md");
    const antes = commit("feat: dois fragmentos, nenhum exige ação");
    git(["checkout", "-q", "-b", "release/7.7.7", antes]);
    rmSync(join(repo, ".changes/g.md"));
    const ponta = commit("release(7.7.7): montada dos fragmentos", BOT);
    git(["checkout", "-q", "main"]);
    git(["merge", "-q", "--no-ff", "-m", "Merge pull request #1001 from release/7.7.7", ponta]);

    expect(decisaoPara(git(["rev-parse", "HEAD"]))).toBe("sim");
  });
});

describe("a guarda recusa ALTO, e não em silêncio, quem apaga fragmento sem ser o App", () => {
  it("apagar fragmento à mão, num commit não assinado pelo App, derruba o passo", () => {
    // A forja que a guarda antiga DEIXAVA passar: escrever a seção no CHANGELOG
    // e esvaziar o diretório criava a tag. Agora não basta apagar — é preciso a
    // identidade do App, que vive em secrets.
    git(["checkout", "-q", "main"]);
    rmSync(join(repo, ".changes/c.md"));
    writeFileSync(join(repo, "CHANGELOG.md"), "# Changelog\n\n## [999.999.999]\n");
    const forjado = commit("feat: parece uma release e não é", "Fulano de Tal");

    const r = recusaPara(forjado);
    expect(r.status, "a guarda tem de sair com 1, e não morrer por outro motivo").toBe(1);
    expect(r.saida).toMatch(/não foi assinado pelo App/);
    expect(r.saida).toMatch(/Fulano de Tal/);
  });

  it("o mesmo apagar, ASSINADO pelo App, corta (controle positivo)", () => {
    // Sem este, "derruba sempre" satisfaria o caso acima.
    fragmento("d.md");
    commit("feat: mais um fragmento");
    rmSync(join(repo, ".changes/d.md"));
    const legitimo = commit("release(999.999.999): montada dos fragmentos", BOT);

    expect(decisaoPara(legitimo)).toBe("sim");
  });
});
