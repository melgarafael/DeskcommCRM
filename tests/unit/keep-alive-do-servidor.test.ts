import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * QUANTO O SERVIDOR SEGURA UMA CONEXÃO OCIOSA — na imagem e no e2e, o mesmo.
 *
 * Com o padrão do Node (5 s + 1 s de `keepAliveTimeoutBuffer`), o servidor fecha
 * a conexão ociosa aos 6 s. Quem reaproveita conexão sem prazo próprio — o
 * `page.request` do Playwright, o proxy na frente da VPS — escreve no socket no
 * instante em que ele morre e recebe `ECONNRESET`/`socket hang up`. Medido nas
 * runs 36069450590 e 36188123417: o GET que morreu veio 5988 e 5998 ms depois da
 * chamada anterior. O porquê do valor está no comentário do `Dockerfile`.
 *
 * Os dois lugares têm de andar juntos: se só o e2e sobe, a suíte deixa de ver a
 * corrida que o produto ainda tem.
 */
const raiz = path.resolve(__dirname, "../..");
const ler = (arquivo: string) => fs.readFileSync(path.join(raiz, arquivo), "utf8");

describe("keep-alive do servidor", () => {
  const naImagem = Number(/KEEP_ALIVE_TIMEOUT=(\d+)/.exec(ler("Dockerfile"))?.[1]);
  const noE2e = Number(/--keepAliveTimeout (\d+)/.exec(ler("playwright.config.ts"))?.[1]);

  it("o e2e sobe o servidor com o mesmo prazo da imagem", () => {
    expect(naImagem).toBeGreaterThan(0);
    expect(noE2e).toBe(naImagem);
  });

  it("o prazo passa do reaproveitamento do proxy (Caddy: 2 min; Traefik: 90 s)", () => {
    // Quem fecha primeiro tem de ser o proxy; senão ele manda a requisição num
    // socket morto e o usuário vê 502.
    expect(naImagem).toBeGreaterThan(120_000);
  });
});
