/**
 * O logo da rede na lista e no cabeçalho, sobre o avatar (#4094).
 *
 * Canal desconhecido desenha o balão genérico: o `marcaDoCanal` não tem ícone
 * para ele (o aviso sai sem logo), mas aqui a falta de ícone viraria um disco
 * vazio em cima da foto.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ChannelLogo } from "./ChannelLogo";

describe("ChannelLogo", () => {
  it("canal desconhecido ainda desenha um ícone", () => {
    const html = renderToStaticMarkup(createElement(ChannelLogo, { channel: null }));
    expect(html).toContain("<svg");
    expect(html).toContain('aria-label="Canal"');
  });
});
