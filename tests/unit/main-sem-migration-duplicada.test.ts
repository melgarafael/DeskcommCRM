/**
 * FORA DE `pull_request`, a guarda por diff é INERTE — e é ali que a duplicata
 * aparece.
 *
 * O verde de um PR é uma foto do passado: medido em 19/09/2026, o #965 estava
 * verde com prévia de 1039 commits atrás e CINCO números já tomados na `main`.
 * Se uma duplicata escapar (prévia velha, merge fora do fluxo, administrador que
 * ignora o check), a `main` tem de reprovar na hora — em vez de a descoberta ser
 * o `supabase db push` de um self-hoster.
 *
 * O passo do `verify-parte` faz essa varredura de árvore no push. Aqui ele é
 * EXECUTADO contra repositórios descartáveis — mesmo método de
 * `tests/shell/colisao-de-migration.test.sh`, que não toca no clone de ninguém.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

/** O corpo do passo, recortado do workflow: o teste mede o que o CI roda. */
const PASSO = (() => {
  const linhas = readFileSync(".github/workflows/ci.yml", "utf-8").split("\n");
  const i = linhas.findIndex((l) => l.includes("A árvore da main tem NNNN ou timestamp repetido?"));
  if (i < 0) throw new Error("o passo saiu do ci.yml");
  const run = linhas.findIndex((l, k) => k > i && /^\s+run: \|$/.test(l));
  const indent = (linhas[run + 1] ?? "").match(/^\s*/)![0].length;
  const corpo: string[] = [];
  for (const l of linhas.slice(run + 1)) {
    if (l.trim() && l.match(/^\s*/)![0].length < indent) break;
    corpo.push(l.slice(indent));
  }
  return corpo.join("\n");
})();

/** Um repositório descartável com N migrations, mais as extras pedidas. */
// Os repositórios descartáveis são apagados no fim: este arquivo roda no projeto
// `cercas`, o primeiro passo da parte 3 do verify (da 1 até 22/09/2026), e lixo em /tmp não é dele
// deixar (achado 10 da revisão do #1268).
const CRIADOS: string[] = [];
afterAll(() => {
  for (const dir of CRIADOS) rmSync(dir, { recursive: true, force: true });
});

function repo(quantas: number, extras: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), "migr-"));
  CRIADOS.push(dir);
  mkdirSync(join(dir, "supabase/migrations"), { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  for (let n = 1; n <= quantas; n++) {
    const nnnn = String(n).padStart(4, "0");
    const ts = `202609${String(10 + (n % 20)).padStart(2, "0")}${String(100000 + n).slice(0, 6)}`;
    writeFileSync(join(dir, `supabase/migrations/${ts}_${nnnn}_x.sql`), "-- x\n");
  }
  for (const nome of extras) writeFileSync(join(dir, `supabase/migrations/${nome}`), "-- x\n");
  git("add", "-A");
  // `--no-verify` não é preciso: repositório novo não tem gancho.
  git("commit", "-qm", "base");
  return dir;
}

function roda(dir: string): { code: number; saida: string } {
  try {
    const saida = execFileSync("bash", ["-c", PASSO], {
      cwd: dir,
      env: { ...process.env, GITHUB_EVENT_NAME: "push" },
      encoding: "utf-8",
      stdio: "pipe",
    });
    return { code: 0, saida };
  } catch (e) {
    const err = e as { status: number; stdout?: string; stderr?: string };
    return { code: err.status, saida: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

describe("a main reprova migration duplicada, mesmo fora de pull_request", () => {
  it("árvore sadia passa", () => {
    const r = roda(repo(150));
    expect(r.saida).toContain("nenhum NNNN nem timestamp repetido");
    expect(r.code).toBe(0);
  });

  it("NNNN repetido reprova, e a saída NOMEIA o número e os dois arquivos", () => {
    const r = roda(repo(150, ["20260930120000_0042_veio_de_outro_pr.sql"]));
    expect(r.code).toBe(1);
    expect(r.saida).toContain("0042");
    expect(r.saida).toContain("veio_de_outro_pr");
    expect(r.saida, "sem o arquivo original nomeado, quem lê não sabe com o que colidiu").toMatch(
      /0042_x\.sql/,
    );
  });

  it("timestamp repetido reprova — é a identidade que o Supabase usa", () => {
    const nomes = execFileSync("bash", ["-c", "ls supabase/migrations | head -1"], {
      cwd: repo(150),
      encoding: "utf-8",
    }).trim();
    const ts = nomes.slice(0, 14);
    const r = roda(repo(150, [`${ts}_0999_outro_slug.sql`]));
    expect(r.code).toBe(1);
    expect(r.saida).toContain(ts);
  });

  it("árvore quase vazia REPROVA como não medido — sonda cega não é aprovação", () => {
    const r = roda(repo(3));
    expect(r.code, "3 migrations deveriam disparar o controle de vivacidade").toBe(2);
    expect(r.saida).toContain("não mediu nada");
  });
});
