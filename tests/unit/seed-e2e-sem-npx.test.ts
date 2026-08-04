import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * TESTE NENHUM CHAMA `npx` — nem para rodar seed, nem para nada.
 *
 * O defeito: 23 call sites faziam `execFileSync("npx", ["tsx", "scripts/
 * seed-e2e-*.ts"], …)`. No Windows o `npx` não é executável, é o shim
 * `npx.cmd` — `execFileSync` sem shell devolve ENOENT para `"npx"` e, desde a
 * mitigação do CVE-2024-27980 (Node >= 18.20 / 20.12 / 22.0), EINVAL para
 * `"npx.cmd"`. Os specs morriam no `beforeAll`, antes de o navegador abrir: a
 * suíte E2E inteira não subia em Windows.
 *
 * O 24º call site NÃO estava em `tests/e2e`: `tests/capture-wave-6-cenarios.ts`
 * subia o controle irmão do cenário D21 com `execFile("npx", …)`. Ali o estrago
 * é pior que vermelho — o `execFile` entrega o erro no callback, o controle
 * viraria `"(não mediu)"` calado, e o critério leria isso como "o ambiente não
 * entrega", absolvendo uma tela sem ter medido nada. Por isso a varredura pega
 * `tests/` inteiro, não só `tests/e2e`.
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
const TESTES = join(RAIZ, "tests");
const PORTA = "tests/e2e/helpers/seed.ts";

/**
 * `tests/unit/` fica FORA da varredura, e não é conveniência: é ali que moram as
 * guardas, e guarda cita o defeito que vigia — este arquivo mesmo escreve
 * `execFileSync("npx"…)` no texto acima. Varrer aqui seria a guarda se acusando.
 * O único caso REAL de `npx` que sobrou sob `tests/unit/` é o
 * `import-puro-sem-env.test.ts`, que abre processo filho para provar import sem
 * ambiente; ele é o mesmo defeito, tem conserto próprio em PR separado e teste
 * próprio — não fica órfão por estar fora daqui.
 */
const FORA = join(TESTES, "unit");

/** Todo `.ts` sob tests/ (menos `FORA`), caminho relativo à raiz. */
function fontesDeTeste(dir = TESTES): string[] {
  if (dir === FORA) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const abs = join(dir, e.name);
    if (e.isDirectory()) return fontesDeTeste(abs);
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
  it("nenhum arquivo de tests/ spawna `npx`", () => {
    // Pega `execFileSync("npx"`, `execFile("npx"`, `spawnSync('npx'` etc. — a
    // forma que quebra é sempre "npx" como PRIMEIRO argumento do spawn. O `\s`
    // casa quebra de linha, então a chamada quebrada em várias linhas (que é
    // como o capture-wave-6 escrevia a dele) não escapa.
    const spawnaNpx = /\b(exec|execFile|execFileSync|spawn|spawnSync)\s*\(\s*["'`]npx["'`]/;
    const culpados = fontesDeTeste()
      // A própria porta cita `execFileSync("npx"…)` no comentário que explica
      // por que ela existe. Quem a vigia é o teste seguinte, olhando o CÓDIGO.
      .filter((rel) => rel !== PORTA)
      .filter((rel) => spawnaNpx.test(readFileSync(join(RAIZ, rel), "utf8")));
    expect(
      culpados,
      `spawn de "npx" em: ${culpados.join(", ")}. Use \`rodaSeed()\` / ` +
        `\`rodaSeedCapturando()\` de ${PORTA}; se precisar da forma assíncrona ` +
        `ou de \`env\` próprio, chame \`process.execPath\` com ` +
        `\`["--import", "tsx", <script>]\` direto. Os dois caminhos rodam o Node ` +
        `que já está de pé, que existe em qualquer SO. NÃO resolva com ` +
        `\`shell: true\`: reabre o buraco de injeção que o CVE-2024-27980 fechou.`,
    ).toEqual([]);
  });

  it("a porta compartilhada roda o Node do processo atual, não um shim do PATH", () => {
    // Sem isto, alguém "conserta" um erro futuro trocando o miolo do helper de
    // volta para `npx` e os 23 call sites voltam a quebrar de uma vez só — com
    // o teste acima ainda verde, porque ele mede quem CHAMA, não o miolo da
    // porta (que é o único lugar autorizado a citar `npx` em prosa).
    const src = semProsa(readFileSync(join(RAIZ, PORTA), "utf8"));
    expect(src, `${PORTA} deve spawnar process.execPath`).toContain("process.execPath");
    expect(src, `${PORTA} deve registrar o tsx via --import`).toContain('"--import", "tsx"');
    expect(src, `${PORTA} não pode usar shell: true`).not.toContain("shell: true");
    expect(src, `${PORTA} não pode voltar a spawnar npx`).not.toMatch(/["'`]npx["'`]/);
  });

  it("os specs realmente passam pela porta (a guarda não vigia arquivo vazio)", () => {
    // Um `tests/e2e` sem nenhum uso do helper deixaria os dois testes acima
    // verdes medindo nada — o verde vazio que a doutrina do repo proíbe.
    const usam = fontesDeTeste().filter((rel) =>
      readFileSync(join(RAIZ, rel), "utf8").includes("./helpers/seed"),
    );
    expect(
      usam.length,
      "nenhum spec importa helpers/seed — a guarda ficou sem objeto",
    ).toBeGreaterThan(10);
  });
});
