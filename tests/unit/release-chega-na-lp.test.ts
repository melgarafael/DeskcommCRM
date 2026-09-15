import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * TODA RELEASE APARECE NA PÁGINA DE CHANGELOG DA LP — E O CI CONFERE.
 *
 * ## A regra
 *
 * `docs/doctrine/versionamento.md`, seção "A vitrine". A LP (repositório
 * `deskcomm-site`) tem uma página de changelog em pt-BR, en e es que lê o
 * `CHANGELOG.md` da `main`. Ninguém escreve release no site: a versão chega lá
 * sozinha, e o último passo do job `cortar-tag` confere que chegou.
 *
 * ## Por que um teste de FORMA
 *
 * O comportamento só existe num corte de release real, e quem o prova é o próprio
 * passo, que falha alto quando a LP não lista a versão. Aqui se guarda o que torna
 * aquele passo verdadeiro — ele existir, rodar DEPOIS das imagens, só no corte e
 * só no repositório oficial, e reprovar em vez de avisar — e o contrato que a LP
 * lê: o formato do cabeçalho de cada seção do CHANGELOG.
 *
 * O contrato mora nos dois lados de propósito. O leitor da LP
 * (`deskcomm-site/lib/changelog.ts`) usa esta mesma expressão; se alguém mudar o
 * cabeçalho do CHANGELOG aqui, este teste reprova ANTES de a LP perder a versão
 * em silêncio.
 */
const RAIZ = process.cwd();
const release = readFileSync(join(RAIZ, ".github/workflows/release.yml"), "utf8");
const doutrina = readFileSync(join(RAIZ, "docs/doctrine/versionamento.md"), "utf8");
const changelog = readFileSync(join(RAIZ, "CHANGELOG.md"), "utf8");

const PASSO_IMAGENS = "- name: As três imagens existem nesta versão?";
const PASSO_LP = "- name: A versão aparece na página de changelog da LP?";

/** O bloco de um passo, do `- name:` até o próximo passo ou o fim do job. */
function passo(nome: string): string {
  const i = release.indexOf(nome);
  if (i === -1) return "";
  const resto = release.slice(i + nome.length);
  const fim = resto.search(/\n {6}- (name|uses):/);
  return nome + (fim === -1 ? resto : resto.slice(0, fim));
}

describe("a release chega à página de changelog da LP", () => {
  it("o passo existe no job cortar-tag, depois da conferência das imagens", () => {
    const iJob = release.indexOf("\n  cortar-tag:");
    const iImagens = release.indexOf(PASSO_IMAGENS);
    const iLp = release.indexOf(PASSO_LP);
    expect(iJob, "o job cortar-tag sumiu").toBeGreaterThan(-1);
    expect(iLp, "o passo que confere a LP sumiu do release.yml").toBeGreaterThan(iJob);
    // Antes das imagens, a LP poderia listar uma versão que o parque ainda não consegue instalar.
    expect(iLp).toBeGreaterThan(iImagens);
  });

  it("roda só num corte de release, e só no repositório oficial", () => {
    const bloco = passo(PASSO_LP);
    const condicao = /\n\s+if: (.+)/.exec(bloco)?.[1] ?? "";
    expect(condicao).toContain("steps.pendente.outputs.cortar == 'sim'");
    expect(condicao).toContain("github.repository == 'melgarafael/DeskcommCRM'");
    // `always()` rodaria depois de uma falha nas imagens e mascararia a causa.
    expect(condicao).not.toContain("always()");
  });

  it("confere os três idiomas e reprova — não só avisa", () => {
    const bloco = passo(PASSO_LP);
    for (const p of ["/changelog", "/en/changelog", "/es/changelog"]) expect(bloco).toContain(p);
    expect(bloco).toContain("https://www.deskcomm.com.br");
    // TODO ramo que anuncia erro precisa sair com 1. Contar "existe um exit 1" não basta: o passo
    // tem dois ramos de erro (a lista e a página da versão), e a sabotagem que tirou só o
    // primeiro passou verde com essa régua.
    const ramos = [...bloco.matchAll(/\n(\s+)if \[[^\n]*\]; then\n([\s\S]*?)\n\1fi\b/g)].map((m) => m[2]);
    const ramosDeErro = ramos.filter((r) => r.includes("::error::"));
    expect(ramosDeErro.length, "o passo deixou de ter os dois ramos de erro").toBe(2);
    for (const r of ramosDeErro) expect(r, "ramo de erro que não reprova o job").toMatch(/\n\s+exit 1(\n|$)/);
    expect(bloco).not.toContain("continue-on-error");
    // A sonda procura o LINK da versão: o número solto casa "1.2.1" dentro de "1.2.10".
    expect(bloco).toContain('href=\\"${p}/${VERSAO}\\"');
  });

  it("a doutrina de versionamento declara a vitrine", () => {
    expect(doutrina).toMatch(/^## A vitrine/m);
    expect(doutrina).toContain("deskcomm.com.br/changelog");
    expect(doutrina).toContain("A versão aparece na página de changelog da LP?");
  });

  it("toda seção do CHANGELOG segue o cabeçalho que a LP sabe ler", () => {
    // A mesma expressão de deskcomm-site/lib/changelog.ts (CABECALHO_VERSAO).
    const CABECALHO_VERSAO = /^## \[(\d+\.\d+\.\d+)\]\s*[—–-]\s*(\d{4}-\d{2}-\d{2})\s*$/;
    const cabecalhos = changelog.split("\n").filter((l) => l.startsWith("## "));
    const fora = cabecalhos.filter((l) => !CABECALHO_VERSAO.test(l) && l.trim() !== "## [Não lançado]");
    expect(fora, "seção que a página de changelog da LP não reconheceria").toEqual([]);
    expect(cabecalhos.filter((l) => CABECALHO_VERSAO.test(l)).length).toBeGreaterThan(0);
  });
});
