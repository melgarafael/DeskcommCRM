/**
 * O ÍCONE DA ABA SUBIDO PELA TELA CHEGA À ABA — e remover devolve o desenhado.
 *
 * ═══ POR QUE ESTA SPEC EXISTE ═══
 *
 * O PR #1826 (@Draven9) tornou o favicon configurável em `/admin/marca`
 * (`CampoDoIconeDaAba`, `peca=icone` na rota do logo, `favicon_path` da migration
 * 0443). Os testes de unidade provam a rota e a conversão caminho → URL; nenhum
 * deles prova a cadeia que o dono do servidor percorre: escolher o arquivo, ver a
 * prévia, e a aba do `/login` de QUEM NÃO ENTROU passar a mostrar esse arquivo.
 * `icone-da-marca.spec.ts` cobre só o caminho sem arquivo (`/icon`).
 *
 * ═══ O QUE SE MEDE, NA ORDEM ═══
 *
 *   1. Precondição: sem ícone subido, o `/login` tem UM `<link rel=icon>`, e ele
 *      aponta para `/icon`. Um só: o layout declara `icons`, e o Next só antepõe
 *      o ícone de arquivo (`app/icon.tsx`) quando `icons` NÃO foi declarado.
 *   2. O dono sobe um PNG pela tela: toast de sucesso e prévia com o arquivo.
 *   3. Numa sessão NOVA e deslogada, o `/login` tem UM link, apontando para o
 *      arquivo no bucket público — e o GET nele devolve os MESMOS bytes subidos
 *      (é o navegador quem baixa; bucket privado ou URL errada aparecem aqui).
 *   4. "Remover ícone" devolve o `/login` ao `/icon`.
 *
 * ═══ VIZINHANÇA NO CI ═══
 *
 * Esta spec ESCREVE a marca da instalação. Ela não pode dividir parte com
 * `icone-da-marca.spec.ts` (que supõe o `/icon`) nem com `marca-logo.spec.ts`
 * (mesmo teto de 10 trocas por usuário a cada 5 min na rota). A restauração é
 * pela ROTA, nunca por SQL: quem invalida o memo da marca da instalação é o
 * código do produto (`invalidarMarcaDaInstalacao`).
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { esperarARevelacaoNasCargas, expect, test, type Browser } from "./helpers/test";

import { lerCreds, loginComoDono } from "./helpers/login-admin";
import { afirmarDonoDoServidor } from "./utils/precondicao";
import { montarPng } from "../helpers/png-sintetico";

const EVIDENCIA = path.join(process.cwd(), "evidence", "icone-da-aba");

function evidencia(nome: string): string {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  return path.join(EVIDENCIA, nome);
}

/** PNG 64×64 de uma cor só — bytes conhecidos para comparar com o que o bucket serve. */
function pngSolido(lado: number, [r, g, b]: [number, number, number]): Buffer {
  const rgba = new Uint8Array(lado * lado * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = r;
    rgba[i + 1] = g;
    rgba[i + 2] = b;
    rgba[i + 3] = 0xff;
  }
  return Buffer.from(montarPng(lado, lado, rgba));
}

const PNG_DO_ICONE = pngSolido(64, [0x0f, 0x76, 0x6e]);

const URL_DO_ARQUIVO =
  /\/storage\/v1\/object\/public\/brand-logos\/platform\/[0-9a-f-]{36}\.png$/;

/** O `href` do ÚNICO `<link rel=icon>` do `/login`, visto por quem não entrou. */
async function iconeDoLoginDeslogado(browser: Browser, nome: string): Promise<string> {
  const contexto = await browser.newContext();
  contexto.on("page", esperarARevelacaoNasCargas);
  try {
    const pagina = await contexto.newPage();
    await pagina.goto("/login");
    // Sem escopo em `head`: com metadata em streaming o Next pode emitir o link
    // no corpo. `toHaveCount` re-tenta até o streaming terminar.
    const links = pagina.locator('link[rel~="icon"]');
    await expect(links, "o <head> do /login tem de declarar UM ícone, não dois").toHaveCount(1);
    const href = await links.getAttribute("href");
    expect(href, "o <link rel=icon> do /login veio sem href").toBeTruthy();
    await pagina.screenshot({ path: evidencia(nome) });
    return new URL(href ?? "", pagina.url()).toString();
  } finally {
    await contexto.close();
  }
}

test.describe("o ícone da aba subido em /admin/marca chega à aba", () => {
  test.beforeAll(async () => {
    await afirmarDonoDoServidor(lerCreds().users.dono!.email);
  });

  test("subir troca o ícone do /login, remover devolve o desenhado", async ({
    page,
    browser,
  }) => {
    // Um login com TOTP (que pode esperar a janela virar) + duas subidas de tela
    // + duas sessões deslogadas: não cabe no teto padrão.
    test.setTimeout(120_000);

    // (1) Precondição: nenhuma spec anterior deixou ícone gravado.
    const antes = await iconeDoLoginDeslogado(browser, "1-login-antes.png");
    expect(new URL(antes).pathname, "precondição: o /login já chega com ícone subido").toBe(
      "/icon",
    );

    await loginComoDono(page, lerCreds());
    await page.goto("/admin/marca");

    let gravado = false;
    try {
      // A hidratação, e não a visibilidade: o input existe no HTML do SSR antes
      // de o React atar o `onChange` (ver `subir()` em marca-logo.spec.ts). O
      // campo do ícone não tem marcador próprio, mas é irmão do campo de logo da
      // instalação no MESMO cartão de `FormularioDaMarca`, sem Suspense entre os
      // dois — hidratam no mesmo commit.
      await expect(
        page.locator("[data-campo-de-logo='instalacao'][data-hidratado]"),
        "o formulário de marca não hidratou — pôr o arquivo agora não dispara nada",
      ).toBeVisible({ timeout: 15_000 });
      await expect(page.locator("[data-previa-do-icone]")).toHaveAttribute(
        "data-previa-do-icone",
        "desenhado",
      );

      // (2) Subir pela tela. `gravado` antes do arquivo: se a subida entrar e o
      // toast não, a limpeza do `finally` ainda precisa rodar (DELETE sem ícone
      // gravado é inócuo).
      gravado = true;
      await page.locator("#icone-da-aba").setInputFiles({
        name: "icone.png",
        mimeType: "image/png",
        buffer: PNG_DO_ICONE,
      });
      await expect(page.getByText("Ícone da aba atualizado.")).toBeVisible({ timeout: 15_000 });
      const previa = page.locator('[data-previa-do-icone="arquivo"] img');
      await expect(previa, "o toast disse atualizado, mas a prévia não trocou").toHaveAttribute(
        "src",
        URL_DO_ARQUIVO,
      );
      await page.screenshot({ path: evidencia("2-admin-marca-previa.png"), fullPage: true });

      // (3) Quem NÃO entrou vê o arquivo na aba — e o arquivo é o que subiu.
      const depois = await iconeDoLoginDeslogado(browser, "3-login-com-icone.png");
      expect(depois, "o /login não passou a apontar para o arquivo subido").toMatch(
        URL_DO_ARQUIVO,
      );
      const resposta = await page.request.get(depois);
      expect(resposta.status(), `GET ${depois}`).toBe(200);
      expect(
        Buffer.from(await resposta.body()).equals(PNG_DO_ICONE),
        "o bucket serviu bytes diferentes dos que a tela subiu",
      ).toBe(true);

      // (4) Remover pela tela devolve o desenhado.
      await page.getByRole("button", { name: "Remover ícone", exact: true }).click();
      await expect(page.getByText("Ícone da aba removido.")).toBeVisible({ timeout: 15_000 });
      gravado = false;
      await expect(page.locator("[data-previa-do-icone]")).toHaveAttribute(
        "data-previa-do-icone",
        "desenhado",
      );
      const removido = await iconeDoLoginDeslogado(browser, "4-login-depois-de-remover.png");
      expect(new URL(removido).pathname, "remover não devolveu o /login ao /icon").toBe("/icon");
    } finally {
      // Estouro no meio não pode deixar favicon gravado para as specs seguintes
      // do mesmo banco. Pela rota, com a sessão aal2 deste contexto.
      if (gravado) {
        await page.request.delete("/api/v1/marca/logo?escopo=instalacao&peca=icone");
      }
    }
  });
});
