import { test, expect } from "./helpers/test";

/**
 * A aba do navegador — o único pedaço da marca que aparece em TODA tela,
 * inclusive antes de existir sessão, e o único que nenhum teste vigiava.
 *
 * Antes desta spec: `grep -rn 'toHaveTitle|page.title()' tests/e2e/` devolvia
 * vazio e nenhum teste citava favicon ou `generateMetadata`. Quem mexesse no
 * `template` do título ou no `<head>` do layout não era avisado por gate
 * nenhum — num repositório que já pagou a lição de que rótulo visível é
 * contrato.
 *
 * Tudo aqui roda DESLOGADO de propósito. É o estado do comprador que acabou de
 * instalar e abriu a primeira tela: se o ícone responder 307 para o login (era
 * o comportamento antes de `/icon` entrar em PUBLIC_PATHS), a marca dele não
 * aparece exatamente na primeira impressão. E, por não precisar de login, esta
 * spec não consome do teto de 60 logins/IP/300s que a suíte compartilha.
 */
test.describe("o ícone e o título carregam a marca da instalação", () => {
  test("GET /icon responde imagem para quem não entrou", async ({ request }) => {
    const res = await request.get("/icon", { maxRedirects: 0 });

    // 307 aqui significa que o proxy interceptou: o matcher de `proxy.ts` só
    // dispensa caminho COM extensão, e `/icon` não tem nenhuma.
    expect(
      res.status(),
      "esperava a imagem; 307 significa que /icon caiu no redirect para /login",
    ).toBe(200);
    expect(res.headers()["content-type"]).toMatch(/^image\//);

    // O corpo tem de ser um PNG DE VERDADE. Sem esta asserção, um handler que
    // devolvesse 200 com corpo vazio (ou com o HTML de erro do Next) passaria.
    const corpo = await res.body();
    expect(corpo.byteLength).toBeGreaterThan(100);
    expect([...corpo.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  test("o <head> do login declara o ícone — é o que mata o pedido a /favicon.ico", async ({
    page,
  }) => {
    await page.goto("/login");
    const href = await page
      .locator('link[rel~="icon"]')
      .first()
      .getAttribute("href");
    expect(href, "nenhum <link rel=icon> no <head>").toBeTruthy();
    // `/icon` com ou sem query de cache-busting do Next.
    expect(new URL(href ?? "", "http://x").pathname).toBe("/icon");
  });

  test("o título da aba herda a marca resolvida, e é a MESMA que a tela mostra", async ({
    page,
  }) => {
    await page.goto("/login");
    const titulo = await page.title();

    // `template: "%s · ${name}"` no layout raiz: a página filha declara só
    // "Entrar" e herda o sufixo. Um layout que perdesse o template deixaria o
    // título como "Entrar" pelado, e ninguém notaria.
    const casou = /^Entrar · (.+)$/.exec(titulo);
    expect(casou, `título fora do formato "Entrar · <marca>": ${titulo}`).not.toBeNull();

    const marcaNoTitulo = casou?.[1] ?? "";
    expect(marcaNoTitulo.length).toBeGreaterThan(0);

    // Cruza DUAS resoluções independentes: o título vem de `generateMetadata`
    // (que lê `platform_branding` no banco) e o texto sob o "Entrar" vem de
    // `branding()` (que lê o `.env`). Divergirem é defeito de verdade — foi
    // por não cruzar isso que "trocar o nome pela tela e a aba não acompanhar"
    // passou despercebido antes.
    await expect(page.getByText(marcaNoTitulo, { exact: true }).first()).toBeVisible();
  });
});
