/**
 * #374 — os guards têm de julgar o que o COMMIT introduz, não o conjunto que o
 * MERGE trouxe.
 *
 * A medição da issue (`git merge origin/main` numa branch de trabalho) é de
 * git de verdade e foi feita no shell, antes deste arquivo: o caminho
 * CONFLITUDO já passava, e o caminho LIMPO era o que ainda saía recusado — o
 * git chama `pre-merge-commit` antes de escrever o `MERGE_HEAD`, então as seis
 * referências de procedência do `freeze-invariants.sh` não tinham por onde
 * começar e a guarda falhava FECHADO sobre o que a `main` trouxe. Este arquivo
 * mede o CÁLCULO do alcance num repositório fixture montado à mão (sem um
 * `git merge` sequer): as entradas do cálculo são encenadas como o merge as
 * deixaria, e o que se mede é a decisão do guard.
 *
 * Os três casos, e por que os três juntos:
 *
 *   (a) o que a `main` já tem encenado como `A`/`M` não é autoria de quem
 *       commita — migration, invariante e `plan/features.json` trazidos pelo
 *       merge passam. Com a SABOTAGEM obrigatória: o guard de volta ao
 *       comportamento antigo (sem o sinal do outro lado) deixa o MESMO estado
 *       VERMELHO, sem o que o caso mediria "hook apagado".
 *   (b) a branch que CRIA migration com sequência já usada segue BARRADA — é a
 *       metade sem a qual o conserto seria "desligar o guard".
 *   (c) invariante novo da branch passa, e o invariante da main MODIFICADO pela
 *       branch segue barrado — a catraca continua de pé.
 *
 * Os dois guards de migration irmãos (`.agents/`, o do contribuidor, e
 * `loop/hooks/`, o do mantenedor) são medidos nos dois casos que lhes dizem
 * respeito: são cópias separadas com regras próprias, e uma delas consertada
 * não prova nada da outra.
 */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const FREEZE = "loop/hooks/freeze-invariants.sh";
const MIG_MANTENEDOR = "loop/hooks/check-migration-triple.sh";
const MIG_CONTRIBUIDOR = ".agents/skills/deskcomm-contribuir/scripts/hooks/check-migration-triple.sh";
const PLANO_GUARD = "loop/hooks/validate-features.sh";
const POPULACAO = "scripts/migration-populacao.sh";

const INV = "tests/invariants/congelado.test.ts";
const PLANO = "plan/features.json";
const MIG_MAIN = "supabase/migrations/20260102000000_0411_da_main.sql";
const CONGELADO = 'import { it } from "vitest";\nit("o congelado vigia", () => {});\n';

/** A guarda de `plan/features.json` exige jq — sem ele não há o que medir. */
const temJq = (() => {
  try {
    execFileSync("jq", ["--version"]);
    return true;
  } catch {
    return false;
  }
})();

// isolamento de config: mesmo tripé dos testes de shell da pasta — um arquivo
// VAZIO de verdade, porque tem runner em que git lê /dev/null e morre nele, e
// nada aqui pode herdar `core.hooksPath` ou identidade de quem roda.
const RAIZ = process.cwd();
const HOME_FIXTURE = mkdtempSync(join(tmpdir(), "hooks-374-"));
const GITCONFIG_VAZIO = join(HOME_FIXTURE, "gitconfig-vazio");
writeFileSync(GITCONFIG_VAZIO, "");
const ENV_BASE: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: GITCONFIG_VAZIO,
  GIT_CONFIG_SYSTEM: GITCONFIG_VAZIO,
  HOME: HOME_FIXTURE,
};

const dirAtuais: string[] = [];
afterEach(() => {
  while (dirAtuais.length > 0) rmSync(dirAtuais.pop()!, { recursive: true, force: true });
});

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, env: ENV_BASE, encoding: "utf-8" }).trim();
}

type Saida = { rc: number; saida: string };

function rodar(dir: string, hook: string, env: Record<string, string> = {}): Saida {
  try {
    const saida = execFileSync("bash", [join(RAIZ, hook)], {
      cwd: dir,
      env: { ...ENV_BASE, ...env },
      encoding: "utf-8",
    });
    return { rc: 0, saida };
  } catch (erro) {
    const e = erro as { status?: number; stdout?: string; stderr?: string };
    return { rc: e.status ?? 1, saida: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

/**
 * Um clone pequeno, sem rede e sem um `git merge` sequer: `main` tem uma
 * migration e um invariante, `origin/main` é um commit à frente que publica a
 * 0411 e REESCREVE o invariante, e `trabalho` saiu do ponto anterior com um
 * commit próprio que não encosta em nenhum dos dois.
 */
function fixture(): { dir: string; ponta: string; base: string } {
  const dir = mkdtempSync(join(tmpdir(), "hooks-374-fx-"));
  dirAtuais.push(dir);
  mkdirSync(join(dir, "tests/invariants"), { recursive: true });
  mkdirSync(join(dir, "plan"), { recursive: true });
  mkdirSync(join(dir, "supabase/migrations"), { recursive: true });
  mkdirSync(join(dir, "scripts"), { recursive: true });
  copyFileSync(join(RAIZ, POPULACAO), join(dir, POPULACAO));

  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "Teste");
  git(dir, "config", "user.email", "teste@exemplo.invalid");
  git(dir, "config", "commit.gpgsign", "false");

  writeFileSync(join(dir, INV), CONGELADO);
  writeFileSync(join(dir, PLANO), '{"features":[{"id":"a","passes":1}]}\n');
  writeFileSync(join(dir, "supabase/migrations/20260101000000_0410_da_main.sql"), "select 1;\n");
  writeFileSync(join(dir, "supabase/baseline.sql"), "-- baseline\n");
  writeFileSync(join(dir, "supabase/migrations/MANIFEST.md"), "| 0410 |\n");
  writeFileSync(join(dir, "README.md"), "# repo\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  const base = git(dir, "rev-parse", "HEAD");

  // a main avança: publica a 0411 e reescreve o invariante
  writeFileSync(join(dir, MIG_MAIN), "select 2;\n");
  writeFileSync(join(dir, "supabase/baseline.sql"), "-- baseline\n-- 0411\n");
  writeFileSync(join(dir, "supabase/migrations/MANIFEST.md"), "| 0410 |\n| 0411 |\n");
  writeFileSync(
    join(dir, INV),
    `${CONGELADO}it("o que a main publicou depois", () => {});\n`,
  );
  writeFileSync(join(dir, PLANO), '{"features":[{"id":"a","passes":1},{"id":"b","passes":1}]}\n');
  writeFileSync(join(dir, "README.md"), "# repo\nlinha que a main acrescentou\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "a main avanca");
  const ponta = git(dir, "rev-parse", "HEAD");
  git(dir, "update-ref", "refs/remotes/origin/main", ponta);

  git(dir, "checkout", "-q", "-b", "trabalho", base);
  writeFileSync(join(dir, "meu-trabalho.txt"), "so o meu trabalho\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "meu commit proprio");
  return { dir, ponta, base };
}

/** Encena o que o merge deixaria no ÍNDICE — sem executar merge algum. */
function trazERescreve(dir: string, caminho: string): void {
  git(dir, "checkout", "origin/main", "--", caminho);
  git(dir, "add", "--", caminho);
}

// `--git-path` devolve caminho relativo ao worktree; o ARQUIVO é que decide.
const temMERGE_HEAD = (dir: string): boolean =>
  existsSync(join(dir, git(dir, "rev-parse", "--git-path", "MERGE_HEAD")));

/**
 * SABOTAGEM: o guard de volta ao comportamento ANTES do conserto. O bloco que
 * resolve o outro lado pelo sinal da rota (`GITHEAD_*`) é desligado com um
 * token — `outro_lado` fica vazio, `lados` fica 0 e nenhuma exclusão acontece,
 * que era exatamente o estado medido na issue.
 */
function guardSaboutado(): string {
  const fonte = readFileSync(join(RAIZ, FREEZE), "utf-8");
  const sabotado = fonte.replace('if [ -z "$outro_lado" ]; then', "if false; then");
  expect(sabotado, "o marcador da sabotagem não foi encontrado no guard").not.toBe(fonte);
  const caminho = join(HOME_FIXTURE, "freeze-sabotado.sh");
  writeFileSync(caminho, sabotado);
  chmodSync(caminho, 0o755);
  return caminho;
}

function rodarSaboutado(dir: string, env: Record<string, string> = {}): Saida {
  const hook = guardSaboutado();
  try {
    const saida = execFileSync("bash", [hook], {
      cwd: dir,
      env: { ...ENV_BASE, ...env },
      encoding: "utf-8",
    });
    return { rc: 0, saida };
  } catch (erro) {
    const e = erro as { status?: number; stdout?: string; stderr?: string };
    return { rc: e.status ?? 1, saida: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

describe("hooks não acusam o MERGE da main (#374)", () => {
  it("(a) migration que a main publicou, encenada como A, NÃO é autoria de quem commita", () => {
    const { dir } = fixture();
    trazERescreve(dir, MIG_MAIN);

    // premissa: o git a enxerga como ADIÇÃO relativa à branch — é o que o merge
    // deixa no índice e é o que os dois guards liam como "a autoria do autor".
    expect(git(dir, "diff", "--cached", "--name-status", "--", MIG_MAIN)).toContain(`A\t${MIG_MAIN}`);
    expect(git(dir, "ls-tree", "--name-only", "HEAD", "--", MIG_MAIN)).toBe("");

    expect(rodar(dir, MIG_CONTRIBUIDOR).rc).toBe(0);
    expect(rodar(dir, MIG_MANTENEDOR).rc).toBe(0);
  });

  it("(a) invariante que a main reescreveu, no caminho SEM MERGE_HEAD, não é acusado", () => {
    const { dir, ponta } = fixture();
    trazERescreve(dir, INV);

    // premissa de medição: este é o estado do caminho LIMPO — sem MERGE_HEAD
    // (o git só o escreve depois do `pre-merge-commit`) e com o outro lado
    // entregue em `GITHEAD_<sha>=<ref>`, que é o que o git faz naquele instante.
    expect(temMERGE_HEAD(dir)).toBe(false);
    expect(git(dir, "diff", "--cached", "--name-status", "--", INV)).toContain(`M\t${INV}`);

    const sinal: Record<string, string> = { [`GITHEAD_${ponta}`]: "origin/main" };
    expect(rodar(dir, FREEZE, { ...sinal }).rc).toBe(0);
  });

  it.skipIf(!temJq)(
    "(a) plan/features.json que a main publicou, no caminho SEM MERGE_HEAD, também não é acusado",
    () => {
      const { dir, ponta } = fixture();
      trazERescreve(dir, PLANO);

      // mesma premissa de medição do caso do invariante: o caminho LIMPO, sem
      // MERGE_HEAD, com o outro lado só em `GITHEAD_*`.
      expect(temMERGE_HEAD(dir)).toBe(false);
      expect(git(dir, "diff", "--cached", "--name-status", "--", PLANO)).toContain(`M\t${PLANO}`);

      const sinal: Record<string, string> = { [`GITHEAD_${ponta}`]: "origin/main" };
      expect(rodar(dir, PLANO_GUARD, { ...sinal }).rc).toBe(0);

      // e sem sinal nenhum dos dois a guarda continua FECHADA: o conserto
      // acrescentou uma FONTE para o outro lado, não apagou a barreira.
      expect(rodar(dir, PLANO_GUARD).rc).toBe(1);
    },
  );

  /**
   * O sinal do outro lado é FORJÁVEL: `GITHEAD_*` é variável de ambiente e
   * `.git/MERGE_HEAD` se escreve à mão. Um commit COMUM, numa branch em dia com a
   * main, volta o plano à versão de um ANCESTRAL da main (apaga a feature "b") e
   * aponta o sinal para esse ancestral. Sem as condições (d) índice == ponta da
   * main e (e) HEAD == merge-base, as duas rotas saíam 0 (medido; a do
   * MERGE_HEAD já saía 0 na main antes do #374).
   */
  for (const rota of ["GITHEAD_<ancestral> forjado", "MERGE_HEAD escrito à mão"]) {
    it.skipIf(!temJq)(`(d) plano voltado a um ancestral da main com ${rota} continua BARRADO`, () => {
      const { dir, ponta, base } = fixture();
      git(dir, "checkout", "-q", "-b", "em-dia", ponta);
      git(dir, "checkout", base, "--", PLANO);
      git(dir, "add", "--", PLANO);
      // premissa: o índice é exatamente o blob do outro lado forjado — a condição
      // antiga (índice == outro lado) vale, e é isso que o ataque explora.
      expect(git(dir, "rev-parse", `:${PLANO}`)).toBe(git(dir, "rev-parse", `${base}:${PLANO}`));

      let env: Record<string, string> = {};
      if (rota.startsWith("GITHEAD")) env = { [`GITHEAD_${base}`]: "origin/main" };
      else writeFileSync(join(dir, git(dir, "rev-parse", "--git-path", "MERGE_HEAD")), `${base}\n`);

      const r = rodar(dir, PLANO_GUARD, env);
      expect(r.rc, r.saida.slice(0, 400)).toBe(1);
    });
  }

  it("(a) SABOTAGEM: guard de volta ao comportamento antigo deixa o MESMO estado VERMELHO", () => {
    const { dir, ponta } = fixture();
    trazERescreve(dir, INV);
    const sinal: Record<string, string> = { [`GITHEAD_${ponta}`]: "origin/main" };

    const sabotado = rodarSaboutado(dir, { ...sinal });
    expect(sabotado.rc, `a sabotagem não ficou vermelha: ${sabotado.saida.slice(0, 400)}`).toBe(1);
    expect(sabotado.saida).toContain(INV);
  });

  it("(b) a branch que CRIA migration com sequência já usada segue BARRADA nos dois guards", () => {
    const { dir } = fixture();
    writeFileSync(join(dir, "supabase/migrations/20260303000000_0410_copia_minha.sql"), "select 3;\n");
    writeFileSync(join(dir, "supabase/baseline.sql"), "-- baseline\n-- copia\n");
    writeFileSync(join(dir, "supabase/migrations/MANIFEST.md"), "| 0410 |\n| copia |\n");
    git(dir, "add", "-A");

    // premissa: a sequência 0410 está na população (origin/main) e o arquivo é
    // novo — é colisão de verdade, não o arquivo que o merge trouxe.
    expect(git(dir, "diff", "--cached", "--name-status", "--", "supabase/migrations")).toContain(
      "0410_copia_minha.sql",
    );

    const contribuidor = rodar(dir, MIG_CONTRIBUIDOR);
    expect(contribuidor.rc, contribuidor.saida.slice(0, 400)).toBe(1);
    expect(contribuidor.saida).toContain("0410");

    const mantenedor = rodar(dir, MIG_MANTENEDOR);
    expect(mantenedor.rc, mantenedor.saida.slice(0, 400)).toBe(1);
    expect(mantenedor.saida).toContain("0410");
  });

  it("(b) e um número de fato livre continua passando — o guard não virou bloqueio cego", () => {
    const { dir } = fixture();
    writeFileSync(join(dir, "supabase/migrations/20260303000000_0412_livre.sql"), "select 4;\n");
    writeFileSync(join(dir, "supabase/baseline.sql"), "-- baseline\n-- livre\n");
    writeFileSync(join(dir, "supabase/migrations/MANIFEST.md"), "| 0410 |\n| livre |\n");
    git(dir, "add", "-A");

    expect(rodar(dir, MIG_CONTRIBUIDOR).rc).toBe(0);
    expect(rodar(dir, MIG_MANTENEDOR).rc).toBe(0);
  });

  // A descrição saiu do MANIFEST.md para o próprio .sql (`-- manifest: ...`): o
  // MANIFEST era o arquivo que todo PR com migration tocava, e o GitHub ignora o
  // merge=union. O .sql é GRANDE de propósito: com `pipefail`, um `grep -q` fecha
  // o cano antes de o `git show` terminar e a descrição presente lê como ausente.
  it("(e) descrição no cabeçalho do .sql passa SEM tocar o MANIFEST, nos dois guards", () => {
    const { dir } = fixture();
    const corpo = "select 5;\n".repeat(50_000);
    writeFileSync(
      join(dir, "supabase/migrations/20260303000000_0412_descrita.sql"),
      `-- manifest: a descrição mora no arquivo\n${corpo}`,
    );
    writeFileSync(join(dir, "supabase/baseline.sql"), "-- baseline\n-- descrita\n");
    git(dir, "add", "-A");
    expect(git(dir, "diff", "--cached", "--name-only")).not.toContain("MANIFEST.md");

    const contribuidor = rodar(dir, MIG_CONTRIBUIDOR);
    expect(contribuidor.rc, contribuidor.saida.slice(0, 400)).toBe(0);
    const mantenedor = rodar(dir, MIG_MANTENEDOR);
    expect(mantenedor.rc, mantenedor.saida.slice(0, 400)).toBe(0);
  });

  it("(e) migration sem descrição em lugar nenhum segue BARRADA nos dois guards", () => {
    const { dir } = fixture();
    writeFileSync(join(dir, "supabase/migrations/20260303000000_0412_muda.sql"), "-- manifest:\nselect 6;\n");
    writeFileSync(join(dir, "supabase/baseline.sql"), "-- baseline\n-- muda\n");
    git(dir, "add", "-A");

    for (const hook of [MIG_CONTRIBUIDOR, MIG_MANTENEDOR]) {
      const r = rodar(dir, hook);
      expect(r.rc, `${hook}: ${r.saida.slice(0, 400)}`).toBe(1);
      expect(r.saida).toContain("sem descrição");
    }
  });

  it("(c) invariante NOVO da branch passa — a catraca não é bloqueio de tudo", () => {
    const { dir } = fixture();
    writeFileSync(join(dir, "tests/invariants/novo-da-branch.test.ts"), CONGELADO);
    git(dir, "add", "--", "tests/invariants/novo-da-branch.test.ts");
    expect(git(dir, "diff", "--cached", "--name-status", "--", "tests/invariants")).toContain(
      "A\ttests/invariants/novo-da-branch.test.ts",
    );

    expect(rodar(dir, FREEZE).rc).toBe(0);
  });

  it("(c) invariante da main MODIFICADO pela branch continua BARRADO", () => {
    const { dir } = fixture();
    writeFileSync(
      join(dir, INV),
      'import { it } from "vitest";\nit("o congelado vigia qualquer coisa", () => {});\n',
    );
    git(dir, "add", "--", INV);
    expect(git(dir, "diff", "--cached", "--name-status", "--", INV)).toContain(`M\t${INV}`);

    const r = rodar(dir, FREEZE);
    expect(r.rc, r.saida.slice(0, 400)).toBe(1);
    expect(r.saida).toContain(INV);
  });
});
