/**
 * O executor próprio (infra/executor-proprio/) só pode rodar trabalho NOSSO.
 *
 * O repositório é público. Num `pull_request` de fork o GitHub roda o workflow
 * da branch do fork, então quem abre o PR pode reescrever `runs-on:` e mirar a
 * nossa máquina. Duas camadas, e este arquivo vigia as duas:
 *
 *   1. A GUARDA na máquina (so-o-que-e-nosso.sh, gravada na imagem): é a que
 *      vale contra fork. Ela é EXECUTADA aqui contra payloads de cada origem.
 *   2. O ROTEAMENTO nos nossos workflows: decide para quem não o edita. Só os
 *      jobs pesados vão para a máquina, e a publicação na `main` nunca vai —
 *      imagem que o parque instala se constrói nas máquinas do GitHub.
 *
 * Desde 12/11/2026 há um SEGUNDO executor, os runners da VPS (`deskcomm-vps`),
 * e ele recebe só a matriz `invariants-majors`. O roteamento dele é vigiado
 * aqui com a mesma régua; a guarda de entrada é o mesmo so-o-que-e-nosso.sh,
 * instalado no `.env` de cada runner (fora do repositório).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const GUARDA = "infra/executor-proprio/so-o-que-e-nosso.sh";
const REPO = "melgarafael/DeskcommCRM";

function guarda(evento: string, payload: unknown, repo = REPO, ator = "melgarafael"): number {
  const dir = mkdtempSync(join(tmpdir(), "guarda-"));
  const caminho = join(dir, "evento.json");
  writeFileSync(caminho, typeof payload === "string" ? payload : JSON.stringify(payload));
  try {
    execFileSync("bash", [GUARDA], {
      // Herda o ambiente (ProcessEnv exige NODE_ENV) e SOBRESCREVE as quatro que a
      // guarda lê — no CI elas existem e descreveriam o job de verdade (num PR do
      // dependabot, GITHUB_ACTOR já viria `dependabot[bot]`).
      env: { ...process.env, GITHUB_REPOSITORY: repo, GITHUB_EVENT_NAME: evento, GITHUB_EVENT_PATH: caminho, GITHUB_ACTOR: ator },
      stdio: "pipe",
    });
    return 0;
  } catch (e) {
    return (e as { status: number }).status;
  }
}

const prDe = (origem: string | null) => ({ pull_request: { head: { repo: origem ? { full_name: origem } : null } } });

describe("a guarda da máquina", () => {
  it.each([
    ["push", {}],
    ["workflow_dispatch", {}],
    ["schedule", {}],
    ["merge_group", {}],
    ["pull_request", prDe(REPO)],
  ])("aceita %s de dentro do repositório", (evento, payload) => {
    expect(guarda(evento, payload)).toBe(0);
  });

  it.each([
    ["pull_request de fork", "pull_request", prDe("alguem/DeskcommCRM")],
    ["pull_request com o fork apagado", "pull_request", prDe(null)],
    ["pull_request com payload ilegível", "pull_request", "{isto não é json"],
    ["pull_request_target", "pull_request_target", prDe(REPO)],
    ["issue_comment", "issue_comment", {}],
    ["workflow_run", "workflow_run", {}],
    ["evento vazio", "", {}],
  ])("recusa %s", (_nome, evento, payload) => {
    expect(guarda(evento, payload)).not.toBe(0);
  });

  it.each(["dependabot[bot]", "github-actions[bot]", "renovate[bot]"])(
    "recusa o bot %s mesmo com PR de branch deste repositório e com push",
    (bot) => {
      expect(guarda("pull_request", prDe(REPO), REPO, bot)).not.toBe(0);
      expect(guarda("push", {}, REPO, bot)).not.toBe(0);
    },
  );

  it("controle: o mesmo PR, de gente, passa", () => {
    expect(guarda("pull_request", prDe(REPO), REPO, "webtecnica")).toBe(0);
  });

  it("recusa outro repositório mesmo com evento aceito", () => {
    expect(guarda("push", {}, "alguem/OutroRepo")).not.toBe(0);
  });

  it("a imagem instala a guarda como hook de entrada do runner", () => {
    const dockerfile = readFileSync("infra/executor-proprio/Dockerfile", "utf-8");
    expect(dockerfile).toContain("ACTIONS_RUNNER_HOOK_JOB_STARTED=/opt/deskcomm/so-o-que-e-nosso.sh");
    expect(dockerfile).toMatch(/COPY so-o-que-e-nosso\.sh .*\/opt\/deskcomm\//);
  });
});

// --- roteamento --------------------------------------------------------------

const TODOS =
  "${{ vars.EXECUTOR_PROPRIO == 'ligado' && (github.event_name == 'push' || github.event.pull_request.head.repo.full_name == github.repository) && 'deskcomm-proprio' || 'ubuntu-latest' }}";
const VPS =
  "${{ vars.RUNNER_PROPRIO == 'ligado' && !endsWith(github.actor, '[bot]') && (github.event_name == 'push' || github.event.pull_request.head.repo.full_name == github.repository) && fromJSON('[\"self-hosted\",\"deskcomm-vps\"]') || 'ubuntu-latest' }}";
const SO_PR =
  "${{ matrix.arch == 'arm64' && 'ubuntu-24.04-arm' || (vars.EXECUTOR_PROPRIO == 'ligado' && github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository && 'deskcomm-proprio' || 'ubuntu-latest') }}";

const ESPERADO: Record<string, string> = {
  "ci.yml::verify-parte": TODOS,
  "e2e.yml::e2e-parte": TODOS,
  "perf.yml::build-and-size": TODOS,
  "publish-image.yml::imagem-do-app-sobe": SO_PR,
  "publish-image.yml::imagens-de-fundo-sobem": SO_PR,
};

// Sem parser YAML nas dependências: o `runs-on:` de 4 espaços pertence ao
// último job de 2 espaços visto antes dele.
function runsOnPorJob(): Map<string, string> {
  const mapa = new Map<string, string>();
  for (const arquivo of readdirSync(".github/workflows").filter((a) => /\.ya?ml$/.test(a))) {
    let job = "";
    let emJobs = false;
    for (const linha of readFileSync(`.github/workflows/${arquivo}`, "utf-8").split("\n")) {
      if (/^jobs:\s*$/.test(linha)) emJobs = true;
      const j = emJobs && linha.match(/^ {2}([a-zA-Z0-9_-]+):\s*$/);
      if (j) job = j[1]!;
      const r = linha.match(/^ {4}runs-on: (.*)$/);
      if (r && job) mapa.set(`${arquivo}::${job}`, r[1]!.trim());
    }
  }
  return mapa;
}

describe("o roteamento dos workflows", () => {
  const mapa = runsOnPorJob();

  it("controle positivo: o recorte enxerga os jobs", () => {
    expect(mapa.size).toBeGreaterThanOrEqual(12);
    expect([...mapa.values()]).toContain("ubuntu-latest");
  });

  it("exatamente os jobs pesados podem ir para a máquina, cada um com a expressão declarada", () => {
    const naMaquina = Object.fromEntries([...mapa].filter(([, v]) => v.includes("deskcomm-proprio")));
    expect(naMaquina).toEqual(ESPERADO);
  });

  it("só a matriz do banco vai para os runners da VPS, com a expressão declarada", () => {
    const naVps = Object.fromEntries([...mapa].filter(([, v]) => v.includes("deskcomm-vps")));
    expect(naVps).toEqual({ "ci.yml::invariants-majors": VPS });
  });

  it("o job na VPS usa um HOME do job e limpa os contêineres dele mesmo em falha", () => {
    const ci = readFileSync(".github/workflows/ci.yml", "utf-8");
    const job = ci.slice(ci.indexOf("\n  invariants-majors:\n"), ci.indexOf("\n  invariants:\n"));
    expect(job.length, "não achei o job invariants-majors").toBeGreaterThan(100);
    expect(job).toMatch(/if: runner\.environment == 'self-hosted'\n\s+run: \|[\s\S]*?casa="\$RUNNER_TEMP\/home"[\s\S]*?"HOME=\$casa" >> "\$GITHUB_ENV"/);
    expect(job).toMatch(
      /if: always\(\) && runner\.environment == 'self-hosted'\n\s+run: \|\n\s+ids="\$\(docker ps -aq --filter "label=deskcomm\.worktree=\$GITHUB_WORKSPACE"\)"/,
    );
    // O filtro só limpa o que os scripts rotulam: os dois têm de rotular.
    for (const script of ["scripts/test-db.sh", "scripts/test-update-com-dados.sh"]) {
      expect(readFileSync(script, "utf-8"), script).toMatch(/--label "deskcomm\.worktree=\$(ROOT|DONO_WORKTREE)"/);
    }
  });

  it("o gancho de saída limpa pelo MESMO rótulo que os scripts gravam", () => {
    const gancho = readFileSync("infra/executor-proprio/limpa-depois.sh", "utf-8");
    expect(gancho).toContain('--filter "label=deskcomm.worktree=${GITHUB_WORKSPACE}"');
    // Rótulo por run/job apagaria a outra perna da matriz, que roda ao mesmo
    // tempo no outro runner com o mesmo GITHUB_RUN_ID e GITHUB_JOB.
    expect(gancho).not.toMatch(/label=[^"]*GITHUB_RUN_ID/);
  });

  it("publica cada arquitetura em runner nativo do GitHub", () => {
    expect(mapa.get("publish-image.yml::build-and-push")).toBe(
      "${{ matrix.arch == 'arm64' && 'ubuntu-24.04-arm' || 'ubuntu-latest' }}",
    );
  });

  it("nenhum workflow com pull_request_target manda job para a máquina", () => {
    for (const arquivo of readdirSync(".github/workflows")) {
      const texto = readFileSync(`.github/workflows/${arquivo}`, "utf-8");
      if (!/^\s+pull_request_target:/m.test(texto)) continue;
      expect(texto, arquivo).not.toContain("deskcomm-proprio");
      expect(texto, arquivo).not.toContain("deskcomm-vps");
    }
  });
});
