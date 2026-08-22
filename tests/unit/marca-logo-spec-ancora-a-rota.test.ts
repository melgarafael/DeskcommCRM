/**
 * A SPEC DO LOGO NÃO PODE MEDIR UMA TELA QUE JÁ TROCOU — NEM ESPERAR SEM TETO.
 *
 * ── O defeito que este arquivo guarda (issue #274) ──────────────────────────
 *
 * O caso (1) de `tests/e2e/marca-logo.spec.ts` reprovou 2 de 3 execuções de CI
 * com `element(s) not found` na prévia, e a captura do momento da falha estava
 * na CASCA DO TENANT — não em `/admin/marca`. A leitura natural ("o produto tem
 * um desvio de modo plataforma↔tenant") não se sustenta: nenhum `redirect` para
 * rota de tenant existe fora de `app/app/**`, o `proxy.ts` só desvia `/admin/*`
 * para `/login` ou `/admin/forbidden`, e o fallback de MPA do Next devolve a URL
 * ORIGINAL. Quem larga a página no tenant é o próprio helper de login da spec.
 *
 * MEDIDO neste repositório, com o helper ANTIGO numa sonda que replica o caso
 * (1) sob `Emulation.setCPUThrottlingRate` — 2 reprovações em 18 execuções:
 *
 *   Error: locator.click: Test timeout of 180000ms exceeded.
 *     - waiting for locator('input[aria-label="Dígito 1"]')
 *   FIM url=http://localhost:3001/app/inbox
 *
 * A cadeia: `waitForURL(/\/app\//, { timeout: 8_000 })` desiste enquanto o
 * `verifyMfa` ainda está em voo; o código entra depois; a página vira
 * `/app/inbox`; a retentativa clica num `Dígito 1` que não existe mais; e como
 * `playwright.config.ts` não define `actionTimeout` (default 0 = SEM teto), esse
 * clique espera até o timeout do caso.
 *
 * ── Por que a guarda é sobre o TEXTO da spec ────────────────────────────────
 *
 * O artefato consertado é um TESTE. Não há como cobri-lo por comportamento sem
 * subir o mesmo rig que ele mesmo é (Supabase local + build + Playwright), que é
 * o que o job `e2e` faz uma vez por PR e o `test:unit` não faz nunca. A régua
 * possível aqui é a fonte — mesmo caminho de `tests/unit/branding.test.ts` e
 * `tests/unit/e2e-cobertura-completa.test.ts`. O que ela cobra são PROPRIEDADES
 * (esperar estado terminal, ter teto, ancorar a rota antes de medir), não a
 * escrita exata das linhas.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = process.cwd();
const CAMINHO_SPEC = path.join(RAIZ, "tests/e2e/marca-logo.spec.ts");
const CAMINHO_CONFIG = path.join(RAIZ, "playwright.config.ts");

/**
 * Lê normalizando o fim de linha.
 *
 * `corpoDaFuncao` procura `"\n}\n"` — o fecho na coluna zero. Num checkout
 * Windows o arquivo tem `\r\n`, a busca não acha nada, e o `expect` de dentro do
 * helper derruba a SUÍTE INTEIRA na coleta (0 teste rodado). Vermelho sem defeito,
 * e sem sequer dizer qual asserção falhou.
 */
function lerNormalizado(caminho: string): string {
  return readFileSync(caminho, "utf8").replace(/\r\n/g, "\n");
}

const SPEC = lerNormalizado(CAMINHO_SPEC);
const CONFIG = lerNormalizado(CAMINHO_CONFIG);

/** O corpo de uma função de topo de arquivo, do `{` ao `\n}` da coluna zero. */
function corpoDaFuncao(fonte: string, assinatura: string): string {
  const inicio = fonte.indexOf(assinatura);
  expect(inicio, `não achei \`${assinatura}\` em ${CAMINHO_SPEC}`).toBeGreaterThan(-1);
  const fim = fonte.indexOf("\n}\n", inicio);
  expect(fim, `\`${assinatura}\` não fecha na coluna zero`).toBeGreaterThan(inicio);
  return fonte.slice(inicio, fim);
}

describe("marca-logo.spec.ts: o desafio de MFA espera um estado terminal", () => {
  const corpo = corpoDaFuncao(SPEC, "async function loginComTotp(");

  it("decide por corrida entre os DOIS desfechos, e não por relógio", () => {
    expect(
      corpo,
      "sem `Promise.race`, o helper voltou a apostar num relógio para decidir se o " +
        "login entrou — que é o defeito da issue #274",
    ).toContain("Promise.race");
    expect(
      corpo,
      "a recusa do formulário (`role=alert` do MfaForm) é um dos dois estados terminais; " +
        "sem ela a corrida tem um lado só e volta a ser um relógio",
    ).toContain('getByRole("alert")');
  });

  it("não redigita um código antes de a tentativa anterior terminar", () => {
    // Uma segunda digitação por caminho de exceção é a assinatura exata do
    // helper antigo: `try { waitForURL } catch { dorme; redigita }`.
    expect(
      corpo.match(/page\.keyboard\.type\(/g)?.length ?? 0,
      "o helper voltou a ter mais de um ponto de digitação fora do laço de tentativas",
    ).toBe(1);
    expect(
      corpo,
      "o `catch` que engolia o estouro do `waitForURL` voltou: ele é o que permitia " +
        "digitar por cima de uma tela que já tinha navegado",
    ).not.toMatch(/}\s*catch\s*(\([^)]*\))?\s*{/);
  });

  it("nenhuma espera pela URL aposta num teto curto", () => {
    for (const chamada of corpo.match(/waitForURL\([^;]*?\)/gs) ?? []) {
      const teto = chamada.match(/timeout:\s*([0-9_]+)/);
      if (!teto) continue;
      expect(
        Number(teto[1]!.replace(/_/g, "")),
        `\`${chamada.replace(/\s+/g, " ")}\` desiste cedo demais: numa máquina carregada ` +
          "o verifyMfa demora mais que isso e a página navega depois do estouro",
      ).toBeGreaterThanOrEqual(30_000);
    }
  });

  it("todo clique tem teto — o config do Playwright não dá nenhum", () => {
    const configTemTeto = /actionTimeout\s*:/.test(CONFIG);
    if (configTemTeto) return; // o teto passou a vir do config; a guarda local perde a razão
    for (const clique of corpo.match(/\.click\([^)]*\)/g) ?? []) {
      expect(
        clique,
        "sem `actionTimeout` no playwright.config.ts (default 0 = sem teto), um clique sem " +
          "teto próprio espera até o timeout do CASO quando o controle sumiu",
      ).toMatch(/timeout:\s*[0-9_]+/);
    }
  });
});

describe("marca-logo.spec.ts: a prévia só é medida depois de a rota ser provada", () => {
  it("a âncora fica ENTRE o toast de sucesso e a medição da prévia", () => {
    const iPrevia = SPEC.indexOf("[data-previa-do-logo='claro'] img");
    expect(iPrevia, "não achei a medição da prévia clara").toBeGreaterThan(-1);

    const iToast = SPEC.lastIndexOf("logo atualizado", iPrevia);
    expect(iToast, "não achei a asserção do toast antes da prévia").toBeGreaterThan(-1);

    const iAncora = SPEC.lastIndexOf("aindaNaTelaDeMarca(page", iPrevia);
    expect(
      iAncora,
      "a prévia é medida sem provar a rota antes. O toast NÃO serve de âncora: o " +
        "`<Toaster/>` mora no layout raiz e sobrevive à troca de rota, então " +
        '"Logo atualizado" verde + prévia ausente é o que se vê quando a página já é outra',
    ).toBeGreaterThan(iToast);
  });

  it("a âncora prova a URL E o campo montado", () => {
    const corpo = corpoDaFuncao(SPEC, "async function aindaNaTelaDeMarca(");
    expect(corpo, "a âncora parou de provar a rota").toContain("toHaveURL");
    expect(
      corpo,
      "a âncora parou de provar que o campo de logo está montado — só a URL deixaria passar " +
        "uma casca trocada na mesma rota",
    ).toContain("toBeAttached");
  });
});
