/**
 * `pnpm test:shell` roda `hostgator-setup-kit/test-validators.sh`.
 *
 * É ele que cobre o `install.sh` (issue #191: os casos existiam e não rodavam
 * em job nenhum). Entrou no `test:shell` em 2026-08-08 e SAIU em silêncio em
 * 2026-09-19, na resolução de conflito do merge do #1278 no `package.json` —
 * e o comentário do step "Kit self-host (bash)" do `ci.yml` seguiu afirmando
 * que ele roda. Gate ausente não fica vermelho nem verde: este teste é o que
 * faz a próxima saída ficar vermelha.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("test:shell", () => {
  it("roda os validadores do instalador", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["test:shell"]).toContain("bash hostgator-setup-kit/test-validators.sh");
  });

  // O CI só roda teste de shell por `pnpm test:shell` (ci.yml). Arquivo em
  // tests/shell/ que não está no script não roda em lugar nenhum — foi o caso
  // de `healthcheck-razao-do-agente.test.sh`, que entrou sem a linha aqui.
  it("roda todo tests/shell/*.test.sh", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const testShell = pkg.scripts["test:shell"] ?? "";
    const foraDoScript = readdirSync(join(process.cwd(), "tests/shell"))
      .filter((f) => f.endsWith(".test.sh"))
      .filter((f) => !testShell.includes(`bash tests/shell/${f}`));
    expect(foraDoScript).toEqual([]);
  });

  // Desde 03/11/2026 o CI não roda `pnpm test:shell` de uma vez: a parte 8 do
  // `verify-parte` roda SÓ o arquivo mais pesado e a 7 roda todo o resto
  // (scripts/test-shell-parte.sh). Os erros verdes que isto pega: o passo preso
  // a uma parte só (metade do kit sem rodar), o arquivo pesado renomeado, e um
  // corte que pula ou repete elo. Os pedaços são listados pelo PRÓPRIO script.
  it("os dois pedaços que o CI roda somam o test:shell inteiro, sem repetir", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const todos = (pkg.scripts["test:shell"] ?? "").split(" && ");
    // Controle positivo: o script tinha 62 elos em 03/11/2026.
    expect(todos.length).toBeGreaterThan(50);

    const ci = readFileSync(join(process.cwd(), ".github/workflows/ci.yml"), "utf8");
    const passo = ci.match(
      /- name: Kit self-host \(bash\)\n\s+if: (.*)\n\s+env:\n\s+KIT_PESADO: (\S+)\n\s+run: (.*)\n/,
    );
    expect(passo, "o passo `Kit self-host (bash)` do ci.yml não foi encontrado — esta guarda cegou").not.toBeNull();
    const [, condicao, pesado, run] = passo!;
    expect(condicao, "o kit tem de rodar nas partes 7 e 8").toBe("matrix.parte == 7 || matrix.parte == 8");
    expect(run).toBe(
      `bash scripts/test-shell-parte.sh \${{ matrix.parte == 8 && 'so' || 'menos' }} "$KIT_PESADO"`,
    );

    const pedaco = (modo: string) =>
      execFileSync("bash", ["scripts/test-shell-parte.sh", modo, pesado!], {
        env: { ...process.env, LISTAR: "1" },
        encoding: "utf8",
      })
        .trim()
        .split(" && ");
    expect(pedaco("so")).toEqual([`bash ${pesado}`]);
    const juntos = [...pedaco("so"), ...pedaco("menos")];
    expect(new Set(juntos).size, "um pedaço repete elo do outro").toBe(juntos.length);
    expect([...juntos].sort()).toEqual([...todos].sort());
  });
});
