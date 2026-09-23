import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * SPEC QUE LOGA DUAS VEZES NO TETO PADRÃO MORRE DE RELÓGIO, NÃO DE DEFEITO.
 *
 * Custo medido (PR #1408, run 35538638028, `e2e-parte (2)`): o segundo caso de
 * `protecao-de-envio-nao-congela-o-padrao.spec.ts` morreu com `Test timeout of
 * 30000ms exceeded`, e o produto estava CERTO — o snapshot da falha mostrava o
 * aviso `Proteção de envio atualizada.` já visível na tela. A linha do tempo do
 * trace tinha um `waitForTimeout` de 23,39 s dentro do teto de 30 s.
 *
 * A causa é física, não azar: `tests/e2e/helpers/login-admin.ts` guarda o último
 * código TOTP e, quando o login seguinte cai na MESMA janela de 30 s, espera a
 * próxima janela para não repetir o código (o servidor recusa replay). Dois
 * logins no mesmo arquivo rodam em sequência no mesmo worker, então o segundo
 * cai nessa espera quase sempre — e a espera sozinha pode comer o orçamento
 * inteiro. O veredito que chega ao log é `Test timeout`, que se lê como tela
 * travada; custa uma rodada de e2e de 21 minutos e um download de artefato
 * descobrir que era relógio.
 *
 * Este gate é o mesmo achado em segundos, no `verify`: quem loga duas vezes
 * declara o próprio teto, e o teto declarado precisa caber o padrão MAIS uma
 * janela TOTP inteira. Os dois números são LIDOS do código (o default de
 * `playwright.config.ts` e o período de `tests/e2e/utils/totp.ts`), nunca
 * escritos aqui: gate que guarda número decorado envelhece sozinho.
 *
 * ── O que ele NÃO promete ───────────────────────────────────────────────────
 * Ele conta CALL SITES de login no texto do arquivo. Um login escrito uma vez
 * dentro de um helper local que dois `test` chamam lê como um só, e passa. Foi
 * onde a régua parou porque é onde a prova está: dois call sites são dois
 * logins com certeza. Se essa forma aparecer e morder, o conserto é contar
 * também os `test(` do arquivo — não relaxar este caso.
 */

const DIR_E2E = "tests/e2e";

/** `loginComoAdmin(`, `loginComoDono(`, `loginComoPapel(` — a chamada, não o import. */
const CHAMADA_DE_LOGIN = /\blogin(?:ComoAdmin|ComoDono|ComoPapel)\s*\(/g;

/** `test.describe.configure({ timeout: N })` e `test.setTimeout(N)`. */
const TETO_DECLARADO = /test\.describe\.configure\(\s*\{[^}]*\btimeout\s*:\s*([\d_]+)|test\.setTimeout\(\s*([\d_]+)/g;

function numero(cru: string): number {
  return Number(cru.replace(/_/g, ""));
}

function lerUnico(arquivo: string, padrao: RegExp, oQue: string): number {
  const achado = padrao.exec(readFileSync(arquivo, "utf8"))?.[1];
  // Sonda que não acha devolve `undefined` e faria toda a varredura passar em
  // silêncio: o instrumento quebrado lê igual a "está tudo certo".
  if (!achado) throw new Error(`não achei ${oQue} em ${arquivo} — a sonda deste gate cegou`);
  return numero(achado);
}

describe("spec de e2e que loga duas vezes declara o próprio teto", () => {
  const padraoDoPlaywright = lerUnico(
    "playwright.config.ts",
    /^\s*timeout:\s*([\d_]+),/m,
    "o `timeout` default",
  );
  const janelaTotp = lerUnico(
    join(DIR_E2E, "utils/totp.ts"),
    /const period = ([\d_]+)/,
    "o período da janela TOTP",
  );
  const piso = padraoDoPlaywright + janelaTotp;

  const specs = readdirSync(DIR_E2E)
    .filter((nome) => nome.endsWith(".spec.ts"))
    .map((nome) => ({ nome, fonte: readFileSync(join(DIR_E2E, nome), "utf8") }))
    .filter(({ fonte }) => (fonte.match(CHAMADA_DE_LOGIN) ?? []).length >= 2);

  it("a varredura enxerga specs (senão ela não está medindo nada)", () => {
    expect(specs.length, `nenhuma spec com 2+ logins em ${DIR_E2E} — regex furada?`).toBeGreaterThan(0);
  });

  it.each(specs.map(({ nome }) => nome))("%s declara um teto que cabe o segundo login", (nome) => {
    const fonte = specs.find((s) => s.nome === nome)!.fonte;
    const tetos = [...fonte.matchAll(TETO_DECLARADO)].map((m) => numero(m[1] ?? m[2] ?? ""));

    // `Math.min()` de lista vazia é `Infinity`, que passaria no `toBeGreaterThan`
    // — o caso SEM teto nenhum, que é exatamente o defeito, leria como aprovado.
    // Medido: com esta linha escrita como `Math.min(...tetos, Infinity)`, a
    // sabotagem do conserto no #1408 deixou este gate VERDE.
    expect(
      tetos.length ? Math.min(...tetos) : 0,
      `${nome} loga 2+ vezes: o segundo login espera até uma janela TOTP inteira (${janelaTotp} ms) ` +
        `para não repetir código, e o teto padrão é ${padraoDoPlaywright} ms. Declare ` +
        `\`test.describe.configure({ timeout: ${piso} })\` ou mais — senão a spec morre de ` +
        `\`Test timeout\` com o produto funcionando, e o log culpa a tela.`,
    ).toBeGreaterThanOrEqual(piso);
  });
});
