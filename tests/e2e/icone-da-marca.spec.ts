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
  test("o manifest usa o mesmo nome de instalação que a metadata do login", async ({ page }) => {
    await page.goto("/login");
    const nome = await page.locator('meta[name="application-name"]').getAttribute("content");
    expect(nome).toBeTruthy();
    const resposta = await page.request.get("/manifest.webmanifest");
    expect(resposta.status()).toBe(200);
    const manifest = await resposta.json();
    expect(manifest.name).toBe(nome);
    expect(manifest.short_name).toBe(nome);
  });

  test("o manifest oferece ícones reais de aplicativo antes do login", async ({ page }) => {
    await page.goto("/login");
    const manifest = await (await page.request.get("/manifest.webmanifest")).json();
    expect(manifest.icons.map((icone: { sizes: string }) => icone.sizes)).toEqual([
      "192x192",
      "512x512",
    ]);
    for (const [indice, lado] of [192, 512].entries()) {
      const resposta = await page.request.get(manifest.icons[indice].src, { maxRedirects: 0 });
      expect(resposta.status()).toBe(200);
      expect(resposta.headers()["content-type"]).toMatch(/^image\/png/);
      const png = await resposta.body();
      expect(png.readUInt32BE(16)).toBe(lado);
      expect(png.readUInt32BE(20)).toBe(lado);
    }
  });

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
    const href = await page.locator('link[rel~="icon"]').first().getAttribute("href");
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

    // O título e o texto sob "Entrar" precisam refletir a mesma marca da
    // instalação. ATENÇÃO: os dois leem hoje a MESMA pilha (`marcaDaSaida(null)`
    // e `generateMetadata` → `marcaDaInstalacao()`), então esta asserção só
    // prova que concordam entre si — um resolvedor quebrado deixa as duas
    // erradas e iguais. A verdade independente (o nome digitado na tela chega
    // ao login) está em `marca-logo.spec.ts`, "o nome trocado em /admin/marca…".
    await expect(page.getByText(marcaNoTitulo, { exact: true }).first()).toBeVisible();
  });
});
