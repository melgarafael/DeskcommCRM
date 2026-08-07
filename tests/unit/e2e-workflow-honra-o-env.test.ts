/**
 * QUEM EXIGE O `.env.e2e` E QUEM O CRIA TÊM DE SER O MESMO CONTRATO.
 *
 * ## O defeito
 *
 * `playwright.config.ts` passou a EXIGIR um `.env.e2e` e a falhar alto quando
 * ele falta — a proteção certa, pelo motivo certo: sem esse arquivo o
 * `next start` carrega o `.env.local`, que num checkout de trabalho aponta para
 * PRODUÇÃO, e a suíte semeia organizações e usuários de teste no banco real
 * passando verde.
 *
 * O que saiu incompleto foi a outra ponta: o refactor mudou o contrato do
 * ambiente e não mexeu em `.github/workflows/e2e.yml`. O job seguiu rodando
 * `pnpm build` e chamando a suíte sem gerar nada, e o e2e do PR morreu em
 * `Falta o .env.e2e` — 3m48s de CI para descobrir uma dependência que ninguém
 * declarou em lugar nenhum.
 *
 * ## Por que uma guarda estática, e não "rodar o workflow"
 *
 * Este é um defeito de ACOPLAMENTO entre dois arquivos: um exige, o outro
 * provê. A pergunta é sobre a relação, e ela é decidível lendo os dois. O único
 * jeito de descobri-lo dinamicamente é gastar um job inteiro de CI, que é
 * exatamente o custo que se está tentando não pagar de novo.
 *
 * ## O que se guarda
 *
 * A ORDEM, não a presença: existir um passo que gera o `.env.e2e` não adianta
 * se ele vier depois de quem consome. Por isso a asserção é sobre índices.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const RAIZ = path.resolve(__dirname, "../..");

const workflow = fs.readFileSync(path.join(RAIZ, ".github/workflows/e2e.yml"), "utf8");
const config = fs.readFileSync(path.join(RAIZ, "playwright.config.ts"), "utf8");
const packageJson = JSON.parse(fs.readFileSync(path.join(RAIZ, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

/**
 * Linhas de `run:` do workflow, na ordem em que o job as executa. É a unidade
 * certa: o que importa é qual comando roda antes de qual, não como o passo se
 * chama.
 */
const COMANDOS: string[] = workflow
  .split("\n")
  .filter((l) => !l.trim().startsWith("#"))
  .map((l) => l.trim());

/** Índice do primeiro comando que casa, ou -1. */
function primeiroIndice(padrao: RegExp): number {
  return COMANDOS.findIndex((l) => padrao.test(l));
}

const GERA_ENV = /pnpm (e2e:env|exec .*gerar-env-e2e)|bash scripts\/gerar-env-e2e\.sh/;
const CONSOME_ENV = /pnpm (test:e2e|e2e:build)|playwright test/;

describe("o workflow do e2e honra o contrato de ambiente que a suíte exige", () => {
  it("a suíte de fato exige o .env.e2e (guarda de vacuidade)", () => {
    // Sem isto, o dia em que `playwright.config.ts` parar de exigir o arquivo,
    // os casos abaixo continuariam verdes vigiando uma regra que não existe
    // mais — e o teste viraria peso morto que ninguém percebe.
    expect(config).toMatch(/\.env\.e2e/);
    expect(config, "a exigência tem de FALHAR, não avisar").toMatch(/throw new Error/);
  });

  it("o script que gera o arquivo existe e está no package.json", () => {
    expect(packageJson.scripts["e2e:env"]).toBeTruthy();
    expect(fs.existsSync(path.join(RAIZ, "scripts/gerar-env-e2e.sh"))).toBe(true);
  });

  it("algum passo do workflow gera o .env.e2e ANTES de qualquer passo que o consuma", () => {
    const gera = primeiroIndice(GERA_ENV);
    const consome = primeiroIndice(CONSOME_ENV);

    // Sem consumidor nenhum o caso seria vácuo: nada a ordenar.
    expect(consome, "nenhum passo do workflow roda a suíte — o padrão envelheceu").toBeGreaterThan(
      -1,
    );
    expect(
      gera,
      "nenhum passo gera o .env.e2e; a suíte vai morrer em 'Falta o .env.e2e'",
    ).toBeGreaterThan(-1);
    expect(
      gera,
      "o .env.e2e é gerado DEPOIS de quem precisa dele — existir não basta, tem de vir antes",
    ).toBeLessThan(consome);
  });

  it("o build do job é o que embute as NEXT_PUBLIC_* do ambiente de teste", () => {
    // `pnpm build` puro deixaria a URL do `.env.local` dentro do bundle do
    // browser: servidor falando com um banco e cliente com outro, no mesmo
    // teste. O `e2e:build` existe para exportar o `.env.e2e` antes do build.
    const buildPuro = COMANDOS.some((l) => /^run: pnpm build$/.test(l) || /^pnpm build$/.test(l));
    expect(
      buildPuro,
      "o workflow do e2e builda com o env errado — use `pnpm e2e:build`",
    ).toBe(false);
    expect(packageJson.scripts["e2e:build"]).toBeTruthy();
  });
});
