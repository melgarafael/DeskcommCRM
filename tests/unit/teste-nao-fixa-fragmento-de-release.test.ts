import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Nenhum teste cita um fragmento de release ESPECÍFICO pelo nome.
 *
 * O corte de release consome os fragmentos — apaga todo arquivo de `.changes/`
 * por definição. Um teste que lê ou exige um fragmento nomeado nasce verde no
 * PR que o criou e fica vermelho no PR de release seguinte, que não tem culpa
 * nenhuma. Aconteceu no corte 1.88.0: o teste do #3219 exigia o próprio
 * fragmento e reprovou as cercas do PR de release (retirado em acc40a443).
 *
 * A forma de um fragmento já é validada, enquanto ele existe, pela cerca
 * genérica `fragmentos-de-release.test.ts`. Teste de feature não precisa — e
 * não pode — repetir isso amarrado a um nome.
 *
 * O que conta como citar: o caminho literal `.changes/<nome>.md` (também
 * dentro de `path.resolve(..., "../../.changes/<nome>.md")`) ou os segmentos
 * separados `".changes", "<nome>.md"` de um `join`/`resolve`. Caminho montado
 * por variável não é nome específico e não conta.
 */

const RAIZ = path.resolve(__dirname, "../..");
const DIRETORIOS = ["app", "lib", "components", "hooks", "tests", "scripts"];
const ESTE_ARQUIVO = "tests/unit/teste-nao-fixa-fragmento-de-release.test.ts";
const CITA_FRAGMENTO = /\.changes(?:\/|["'`]\s*,\s*["'`])[\w.-]+\.md\b/;

// Quem cita um nome de fragmento SEM ler o `.changes/` do repositório. Esta
// lista só encolhe: entrada nova exige justificativa, e a entrada que deixa de
// citar reprova até sair (caso "não guarda entrada morta", abaixo).
const PERMITIDOS: Record<string, string> = {
  "tests/unit/guarda-da-release-confere-identidade.test.ts":
    "cria e apaga fragmentos num repositório git TEMPORÁRIO (mkdtemp) para exercitar a guarda da release",
  "tests/unit/guarda-da-release-reconhece-o-corte.test.ts":
    "cria e apaga fragmentos num repositório git TEMPORÁRIO (mkdtemp) para exercitar o reconhecimento do corte",
  "tests/unit/pr-alcanca-o-e2e.test.ts":
    "o nome é só uma string numa lista de caminhos alterados, entrada da função pura que decide o e2e",
  "tests/unit/pr-mexe-na-imagem.test.ts":
    "o nome é só uma string numa lista de caminhos alterados, entrada da função pura que decide o build da imagem",
  "tests/unit/pr-mexe-no-piso-do-postgres.test.ts":
    "o nome é só uma string numa lista de caminhos alterados, entrada da função pura que decide a matriz do Postgres",
};

function* testes(dir: string): Generator<string> {
  for (const entrada of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entrada.name === "node_modules" || entrada.name.startsWith(".")) continue;
    const caminho = path.join(dir, entrada.name);
    if (entrada.isDirectory()) yield* testes(caminho);
    else if (/\.test\.tsx?$/.test(entrada.name)) yield path.relative(RAIZ, caminho).split(path.sep).join("/");
  }
}

const TODOS = DIRETORIOS.filter((d) => fs.existsSync(path.join(RAIZ, d))).flatMap((d) => [
  ...testes(path.join(RAIZ, d)),
]);
const QUE_CITAM = TODOS.filter(
  (f) => f !== ESTE_ARQUIVO && CITA_FRAGMENTO.test(fs.readFileSync(path.join(RAIZ, f), "utf-8")),
);

describe("teste não fixa fragmento de release que o corte vai consumir", () => {
  it("a varredura enxerga a suíte (sonda viva)", () => {
    expect(TODOS.length).toBeGreaterThan(100);
    expect(TODOS).toContain(ESTE_ARQUIVO);
  });

  it("o padrão reconhece as formas que já reprovaram um corte", () => {
    expect(CITA_FRAGMENTO.test('path.resolve(__dirname, "../../.changes/desambigua.md")')).toBe(true);
    expect(CITA_FRAGMENTO.test('join(raiz, ".changes", "x.md")')).toBe(true);
    expect(CITA_FRAGMENTO.test("join(repo, `.changes/${nome}.md`)")).toBe(false);
    expect(CITA_FRAGMENTO.test('join(repo, ".changes/.gitkeep")')).toBe(false);
  });

  it("nenhum teste fora da lista cita um fragmento pelo nome", () => {
    const fora = QUE_CITAM.filter((f) => !(f in PERMITIDOS));
    expect(
      fora,
      "Estes testes citam um fragmento de .changes/ pelo nome. O corte de release apaga os " +
        "fragmentos, e o teste fica vermelho no PR de release. Tire a citação: a forma do " +
        "fragmento já é validada por fragmentos-de-release.test.ts. Se o teste só usa o nome " +
        "num repositório temporário ou como string inerte, ponha-o em PERMITIDOS com a razão:\n  " +
        fora.join("\n  "),
    ).toEqual([]);
  });

  it("a lista não guarda entrada morta", () => {
    expect(Object.keys(PERMITIDOS).filter((f) => !QUE_CITAM.includes(f))).toEqual([]);
  });

  it("toda entrada da lista explica o porquê", () => {
    expect(Object.entries(PERMITIDOS).filter(([, razao]) => razao.trim().length < 20)).toEqual([]);
  });
});
