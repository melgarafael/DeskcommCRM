import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

import { describe, expect, it } from "vitest";

// scripts/pr-mexe-na-imagem.sh decide se um PR pula os builds Docker. Errar
// para "nao" deixa passar imagem quebrada com `imagens-ok` verde — o check
// obrigatório que existe porque o artefato do self-hoster era o único sem gate.
const SCRIPT = "scripts/pr-mexe-na-imagem.sh";

function responde(caminhos: string[]): string {
  return execFileSync("bash", [SCRIPT], { input: caminhos.join("\n") + "\n", encoding: "utf-8" }).trim();
}

describe("pr-mexe-na-imagem", () => {
  it.each([
    ["Dockerfile"],
    ["Dockerfile.worker"],
    ["Dockerfile.scheduler"],
    [".dockerignore"],
    ["package.json"],
    ["pnpm-lock.yaml"],
    ["patches/algum.patch"],
    ["next.config.ts"],
    ["tsconfig.json"],
    ["lib/qualquer.ts"],
    ["workers/event-log.ts"],
    ["docker/scheduler/entrypoint.sh"],
    ["public/logo.png"],
    ["lib/agent-engine/playbooks/platform.md"],
    ["supabase/baseline.sql"],
    [".github/workflows/publish-image.yml"],
    [".github/algum/script.ts"],
  ])("%s → constrói", (caminho) => {
    expect(responde(["docs/leia.md", caminho])).toBe("sim");
  });

  it("entrada vazia constrói — não saber o que mudou nunca vira 'pula'", () => {
    expect(responde([])).toBe("sim");
  });

  it("PR só de documentação, teste, fragmento e workflow alheio pula", () => {
    expect(
      responde([
        "docs/runbooks/deploy.md",
        "tests/unit/x.test.ts",
        "tests/e2e/y.spec.ts",
        ".changes/fragmento.md",
        ".github/workflows/ci.yml",
        "CLAUDE.md",
        "playwright.config.ts",
      ]),
    ).toBe("nao");
  });

  // O espelho: tudo que o `.dockerignore` tira do contexto pode pular. Se alguém
  // acrescenta uma linha lá e não aqui, o PR apenas constrói à toa (custa vaga,
  // não segurança). Se alguém REMOVE uma linha de lá e esquece o script, o
  // caminho passaria a entrar na imagem sem ninguém construir — é esse lado que
  // o teste abaixo cobre, pela volta: toda linha do script tem de estar lá.
  const ignorados = readFileSync(".dockerignore", "utf-8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

  // Um processo bash só, que chama o script por entrada (~50 execuções): menos
  // de um segundo numa máquina ociosa, 18 s numa com carga 90. O teto é para a
  // máquina, não para o script.
  it("toda entrada do .dockerignore pula", { timeout: 60_000 }, () => {
    const amostras = ignorados.map((e) => e.replace(/\*/g, "amostra"));
    const programa = `for a in "$@"; do
      r1=$(printf '%s\\n' "$a" | bash ${SCRIPT})
      r2=$(printf '%s\\n' "$a/amostra.txt" | bash ${SCRIPT})
      [ "$r1" = sim ] && [ "$r2" = sim ] && echo "$a"
    done; true`;
    const naoPulam = execFileSync("bash", ["-c", programa, "_", ...amostras], { encoding: "utf-8" })
      .split("\n")
      .filter(Boolean);
    expect(amostras.length).toBeGreaterThan(15);
    expect(naoPulam).toEqual([]);
  });

  it("o espelho do .dockerignore no script não tem entrada que o .dockerignore não tenha", () => {
    const fonte = readFileSync(SCRIPT, "utf-8");
    const bloco = [...fonte.matchAll(/^\s*(?:\|\s*)?((?:[.\w*-]+(?:\/\*)?\s*\|\s*)*[.\w*-]+(?:\/\*)?)\s*(?:\\|\) ;;)$/gm)]
      .flatMap((m) => (m[1] ?? "").split("|").map((s) => s.trim()))
      .filter(Boolean);
    const doEspelho = bloco
      .map((p) => p.replace(/\/\*$/, ""))
      .filter((p) => !p.startsWith(".github") && p !== "*.md");
    expect(doEspelho.length).toBeGreaterThan(15);
    expect(doEspelho.filter((p) => !ignorados.includes(p))).toEqual([]);
  });

  // A regra acima pula o build quando o PR só mexe no que o `.dockerignore` tira
  // do contexto. Isso só é verdade se NADA que entra na imagem importa de lá —
  // o `next build` typecheca todo `**/*.ts` do contexto, e um import para
  // `tests/` quebra a imagem (TS2307). Aconteceu no #1190 com vitest.config.ts
  // importando de tests/: o PR tocava o workflow, construiu, e o gate pegou. Um
  // PR só de tests/ que mexesse no arquivo importado passaria com o build pulado.
  // Entra no contexto, mas nenhuma imagem o executa nem o typecheca (tsconfig
  // exclui `scripts/**`). A lista só encolhe; entrada nova precisa de razão.
  const SO_FORA_DA_IMAGEM = new Set([
    // seed das credenciais do E2E: roda no job de e2e, contra o Supabase local.
    "scripts/seed-e2e-credentials.ts",
    // smoke do Asaas contra o sandbox (fora do CI, com a chave do dono): importa o
    // dublê de tests/ DE PROPÓSITO — o trabalho dele é medir se as suposições do
    // dublê (somarCiclo, cobranças geradas de saída) batem com o Asaas de verdade.
    "scripts/smoke-asaas.ts",
  ]);

  it("nenhum arquivo que entra na imagem importa de pasta que o .dockerignore exclui", () => {
    const pastasFora = new Set(ignorados.filter((e) => !e.includes("*") && !e.includes(".")));
    for (const p of ["docs", "tests", "tasks"]) expect(pastasFora.has(p)).toBe(true);
    const foraDoContexto = (caminho: string) => pastasFora.has(caminho.split("/")[0] ?? "");

    const arquivos = execFileSync("git", ["ls-files", "*.ts", "*.tsx", "*.mts", "*.js", "*.mjs"], {
      encoding: "utf-8",
    })
      .split("\n")
      .filter((f) => f && !f.startsWith(".") && !foraDoContexto(f) && !f.includes("node_modules/"))
      // Arquivo de teste co-localizado: o tsconfig.json o exclui (`**/*.test.ts`),
      // o `next build` não o typecheca, e nada da imagem o executa.
      .filter((f) => !/\.test\.[cm]?[jt]sx?$/.test(f))
      .filter((f) => !SO_FORA_DA_IMAGEM.has(f));
    expect(arquivos.length).toBeGreaterThan(500);

    const IMPORT = /(?:from\s+|import\s*\(\s*|import\s+|require\(\s*)['"]((?:\.{1,2}\/|@\/)[^'"]+)['"]/g;
    const violacoes: string[] = [];
    for (const f of arquivos) {
      const fonte = readFileSync(f, "utf-8");
      for (const m of fonte.matchAll(IMPORT)) {
        const esp = m[1] ?? "";
        const alvo = esp.startsWith("@/") ? esp.slice(2) : normalize(join(dirname(f), esp));
        if (foraDoContexto(alvo)) violacoes.push(`${f} → ${esp}`);
      }
    }
    expect(violacoes).toEqual([]);
  });
});
