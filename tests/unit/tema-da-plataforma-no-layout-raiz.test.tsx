import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  headers: vi.fn(),
  css: vi.fn(),
}));

vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("@/lib/extensions/tema-da-plataforma", () => ({
  cssDoTemaDaPlataforma: mocks.css,
}));

import { EstiloDoTemaDaPlataforma } from "@/app/tema-da-plataforma";

/**
 * O `<style>` DO TEMA DA PLATAFORMA NO LAYOUT RAIZ (#3790).
 *
 * ── Por que este teste existe ──────────────────────────────────────────────
 *
 * O defeito da issue não é o construtor de CSS (esse já existia, com teste):
 * é que o bloco NUNCA chegava ao `<html>` fora do `/app`. Então o que se mede
 * aqui é a PRESENÇA e a AUSÊNCIA do nó que fica no `<head>` de toda tela —
 * `/admin` inclusive, que é a tela do relato.
 *
 *   - com tema escolhido ⇒ existe `<style id="tema-da-plataforma">` dentro do
 *     `<html>`, e o texto traz o escopo da instalação (`:root:root`);
 *   - sem escolha ⇒ NENHUM nó, nenhum byte. É o caso comum, e é a promessa da
 *     issue: "nada muda para quem não usa".
 *   - `?sem_css=1` ⇒ a leitura é chamada com a folha desligada.
 *
 * O que este arquivo NÃO prova: que o Next emite o nó em produção — isso só o
 * e2e/`next build` prova. Aqui o que se prova é a decisão do componente: com
 * CSS, emite dentro do documento; sem, não emite nada.
 */

const CSS_DO_TEMA = `:root:root {
  --color-bg: #f6f6f4;
}
:root:root[data-theme="dark"] {
  --color-bg: #11151c;
}`;

/** O documento como o layout raiz monta: o `<head>` é onde o nó cai. */
async function documento() {
  return renderToStaticMarkup(
    <html lang="pt-BR" data-theme="light">
      {/* eslint-disable-next-line @next/next/no-head-element -- o documento do teste É
          o `<html>` do layout raiz; não é página do Next, e sim o SSR que ele faz. */}
      <head>{await EstiloDoTemaDaPlataforma()}</head>
      <body />
    </html>,
  );
}

describe("tema da plataforma no layout raiz", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.headers.mockResolvedValue(new Headers());
  });

  it("com tema escolhido, o `<style>` existe no `<html>` e traz o escopo da instalação", async () => {
    mocks.css.mockResolvedValue(CSS_DO_TEMA);

    const html = await documento();

    expect(html).toContain('<style id="tema-da-plataforma">');
    expect(html).toContain(":root:root {");
    expect(html.indexOf('<style id="tema-da-plataforma">')).toBeLessThan(html.indexOf("</head>"));
  });

  it("sem escolha, NÃO existe `<style>` — nada muda para quem não usa", async () => {
    mocks.css.mockResolvedValue(null);

    const html = await documento();

    expect(html).not.toContain("<style");
    expect(html).not.toContain("tema-da-plataforma");
    expect(html).not.toContain("--color-bg");
  });

  it("a leitura recebe a folha desligada quando a requisição traz `?sem_css=1`", async () => {
    mocks.css.mockResolvedValue(null);
    mocks.headers.mockResolvedValue(new Headers({ "x-sem-css-personalizado": "1" }));

    await documento();

    expect(mocks.css).toHaveBeenCalledWith(true);
  });

  it("a folha ligada é pedida como `false` — o interruptor só age quando alguém pede", async () => {
    mocks.css.mockResolvedValue(null);

    await documento();

    expect(mocks.css).toHaveBeenCalledWith(false);
  });
});
