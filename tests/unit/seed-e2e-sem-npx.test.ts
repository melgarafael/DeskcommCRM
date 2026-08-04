import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * SPEC E2E NÃO CHAMA `npx` — nem para rodar seed, nem para nada.
 *
 * O defeito: 23 call sites faziam `execFileSync("npx", ["tsx", "scripts/
 * seed-e2e-*.ts"], …)`. No Windows o `npx` não é executável, é o shim
 * `npx.cmd` — `execFileSync` sem shell devolve ENOENT para `"npx"` e, desde a
 * mitigação do CVE-2024-27980 (Node >= 18.20 / 20.12 / 22.0), EINVAL para
 * `"npx.cmd"`. Os specs morriam no `beforeAll`, antes de o navegador abrir: a
 * suíte E2E inteira não subia em Windows.
 *
 * ⚠️ ESTE TESTE NÃO RODA A SUÍTE E2E — ele lê o FONTE. É de propósito: o CI
 * roda os specs em Linux, onde o defeito não aparece, então nenhum vermelho de
 * E2E vigiaria isto. Um contribuidor em Windows descobriria sozinho, e a leitura
 * mais provável ("meu ambiente está torto") é a que faz ele desistir em vez de
 * abrir issue. Por isso a guarda é estática e mora no `test:unit`, que é check
 * obrigatório da branch protection.
 *
 * O que NÃO está medido aqui: que os seeds efetivamente rodam. Isso é trabalho
 * do `pnpm test:e2e` com banco e dev server de pé — esta guarda só garante que
 * a porta de entrada existe e é portável.
 */

const RAIZ = join(__dirname, "..", "..");
const E2E = join(RAIZ, "tests", "e2e");
const PORTA = "tests/e2e/helpers/seed.ts";

/** Todo `.ts` sob tests/e2e (specs + helpers + utils), caminho relativo à raiz. */
function fontesE2E(dir = E2E): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const abs = join(dir, e.name);
    if (e.isDirectory()) return fontesE2E(abs);
    // Barra normalizada: no Windows o `join` devolve `\`, e o PORTA (e a
    // mensagem de erro que o dev lê) são com `/`.
    return e.name.endsWith(".ts") ? [abs.slice(RAIZ.length + 1).replace(/\\/g, "/")] : [];
  });
}

/** Tira os comentários de bloco: o texto que EXPLICA o defeito não é o defeito. */
function semProsa(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("seed dos specs E2E sobe processo filho de um jeito portável", () => {
  it("nenhum arquivo de tests/e2e spawna `npx`", () => {
    // Pega `execFileSync("npx"`, `execFile("npx"`, `spawnSync('npx'` etc. — a
    // forma que quebra é sempre "npx" como PRIMEIRO argumento do spawn.
    const spawnaNpx = /\b(exec|execFile|execFileSync|spawn|spawnSync)\s*\(\s*["'`]npx["'`]/;
    const culpados = fontesE2E()
      // A própria porta cita `execFileSync("npx"…)` no comentário que explica
      // por que ela existe. Quem a vigia é o teste seguinte, olhando o CÓDIGO.
      .filter((rel) => rel !== PORTA)
      .filter((rel) => spawnaNpx.test(readFileSync(join(RAIZ, rel), "utf8")));
    expect(
      culpados,
      `spawn de "npx" em: ${culpados.join(", ")}. Use \`rodaSeed()\` / ` +
        `\`rodaSeedCapturando()\` de ${PORTA} — elas rodam \`process.execPath\` ` +
        `com \`--import tsx\`, que existe em qualquer SO. NÃO resolva com ` +
        `\`shell: true\`: reabre o buraco de injeção que o CVE-2024-27980 fechou.`,
    ).toEqual([]);
  });

  it("a porta compartilhada roda o Node do processo atual, não um shim do PATH", () => {
    // Sem isto, alguém "conserta" um erro futuro trocando o miolo do helper de
    // volta para `npx` e os 23 call sites voltam a quebrar de uma vez só — com
    // o teste acima ainda verde, porque o `npx` estaria fora de tests/e2e.
    const src = semProsa(readFileSync(join(RAIZ, PORTA), "utf8"));
    expect(src, `${PORTA} deve spawnar process.execPath`).toContain("process.execPath");
    expect(src, `${PORTA} deve registrar o tsx via --import`).toContain('"--import", "tsx"');
    expect(src, `${PORTA} não pode usar shell: true`).not.toContain("shell: true");
    expect(src, `${PORTA} não pode voltar a spawnar npx`).not.toMatch(/["'`]npx["'`]/);
  });

  it("os specs realmente passam pela porta (a guarda não vigia arquivo vazio)", () => {
    // Um `tests/e2e` sem nenhum uso do helper deixaria os dois testes acima
    // verdes medindo nada — o verde vazio que a doutrina do repo proíbe.
    const usam = fontesE2E().filter((rel) =>
      readFileSync(join(RAIZ, rel), "utf8").includes("./helpers/seed"),
    );
    expect(
      usam.length,
      "nenhum spec importa helpers/seed — a guarda ficou sem objeto",
    ).toBeGreaterThan(10);
  });
});
