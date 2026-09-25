import * as http from "node:http";
import type { AddressInfo } from "node:net";

import { test, expect } from "@playwright/test";

import { lerCreds, loginComoAdmin } from "./helpers/login-admin";

/**
 * VOLTAR DA AUTORIZAÇÃO DE REDE SOCIAL NÃO DESLOGA — e diz o desfecho (#1579).
 *
 * Mesmo mecanismo de `agenda-google-volta-nao-desloga.spec.ts`: o provedor
 * devolve o navegador numa navegação iniciada FORA do nosso site, e o cookie
 * de sessão `SameSite=Strict` não viaja nela. Se o destino for uma página
 * autenticada, o `proxy.ts` não vê usuário e manda para `/login`.
 *
 * A ponte `/auth/social-return` é pública e inerte: responde 200 e refaz a
 * navegação a partir do nosso próprio origin, e aí o cookie viaja. A spec segue
 * o DESFECHO — onde a pessoa parou e o que a tela disse —, não o header.
 *
 * O site "de fora" sobe em `127.0.0.1` enquanto o app roda em `localhost`: para
 * o navegador são sites diferentes (porta não conta para SameSite; host conta).
 * Porta 0: o sistema escolhe uma livre, sem colidir com outra spec.
 */
function subirSiteDeFora(destino: string): Promise<http.Server> {
  return new Promise((resolve) => {
    const servidor = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><meta charset="utf-8"><body>
        <a id="voltar" href="${destino}">voltar</a>
        <script>document.getElementById("voltar").click()</script>
      </body>`);
    });
    servidor.listen(0, "127.0.0.1", () => resolve(servidor));
  });
}

test("voltar da autorização de rede social não manda para o /login e mostra o desfecho", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(120_000);
  await loginComoAdmin(page, lerCreds());

  // Controle positivo: logado ANTES do salto. Sem ele, um /login no fim poderia
  // significar "nunca esteve logado" em vez de "perdeu no salto".
  await page.goto("/app/connections?aba=sociais");
  await expect(page, "não cheguei logado em Conexões — o cenário não está montado").toHaveURL(
    /\/app\/connections/,
    { timeout: 20_000 },
  );

  const base = (baseURL ?? "http://localhost:3001").replace(/\/$/, "");
  const destino = `${base}/auth/social-return?connected=facebook&connect_token=SEGREDO`;
  const servidor = await subirSiteDeFora(destino);
  const porta = (servidor.address() as AddressInfo).port;

  try {
    await page.goto(`http://127.0.0.1:${porta}/`);
    await page.waitForURL(/\/(app\/connections|login)/, { timeout: 30_000 });

    const url = page.url();
    expect(
      url,
      `depois de voltar de um site externo, a pessoa parou em ${url}. Ela ESTAVA logada ` +
        "(o controle acima provou): o cookie SameSite=Strict não viajou no salto iniciado de fora.",
    ).not.toContain("/login");
    expect(url).toContain("/app/connections");
    expect(url).toContain("aba=sociais");
    expect(url, "a ponte refletiu o connect_token na URL").not.toContain("SEGREDO");

    await expect(page.getByText(/Autorização concluída/)).toBeVisible({ timeout: 20_000 });
  } finally {
    await new Promise<void>((r) => servidor.close(() => r()));
  }
});
