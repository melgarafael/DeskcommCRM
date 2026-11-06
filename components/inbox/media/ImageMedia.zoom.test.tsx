/**
 * ZOOM NO LIGHTBOX DA IMAGEM (#4149).
 *
 * O lightbox abria a foto ajustada ao modal e parava ali: num print de
 * comprovante, num cupom fotografado, o texto simplesmente não dava para ler, e
 * a saída era baixar o arquivo. O que estes casos prendem é o contrato do
 * clique na imagem ampliada:
 *
 *   ajustada (cursor-zoom-in) --clique--> ampliada (cursor-zoom-out)
 *   ampliada (cursor-zoom-out) --clique--> ajustada
 *
 * O estado mora em `data-ampliada` (botão e imagem) e a classe que o expressa é
 * `w-[200%]` na imagem — é ela que muda o LAYOUT e faz o quadro rolar. Um
 * `scale` de CSS não rola: a imagem passaria por cima da tela.
 *
 * Os casos também guardam o que o zoom NÃO pode quebrar: o `alt` da imagem
 * (descrição de conteúdo, não rótulo de ação), o fechamento por Escape e o
 * estado inicial da abertura seguinte.
 *
 * Sem provider de idioma o `t()` degrada para a chave (pt-BR), então os rótulos
 * esperados aqui são os portugueses — o espanhol é coberto por
 * tests/unit/i18n-espanhol-cobre-a-tela.
 */
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ImageMedia } from "./ImageMedia";

const ALT = "Comprovante do PIX";

/** Miniatura da bolha, já carregada (antes do `onLoad` ela fica desabilitada). */
function miniaturaCarregada() {
  const miniatura = screen.getByLabelText("Ampliar imagem");
  const imagem = miniatura.querySelector("img");
  if (!imagem) throw new Error("a miniatura não tem <img>");
  fireEvent.load(imagem);
  return miniatura;
}

/** Abre o lightbox e devolve o alvo do clique de zoom. */
async function abrirLightbox() {
  render(<ImageMedia messageId="m1" alt={ALT} />);
  await userEvent.click(miniaturaCarregada());
  return screen.getByTestId("lightbox-zoom");
}

describe("ImageMedia — zoom no lightbox", () => {
  it("abre AJUSTADA e o clique na imagem amplia (classe de estado + rótulo da ação)", async () => {
    const alvo = await abrirLightbox();
    const imagem = screen.getByTestId("lightbox-imagem");

    // Estado de chegada: cabe no modal, convite a ampliar.
    expect(alvo.dataset.ampliada).toBe("false");
    expect(alvo.getAttribute("aria-label")).toBe("Ampliar imagem");
    expect(alvo.className).toContain("cursor-zoom-in");
    expect(imagem.dataset.ampliada).toBe("false");
    expect(imagem.className).toContain("max-h-[85vh]");
    expect(imagem.className).not.toContain("w-[200%]");

    await userEvent.click(imagem);

    // Ampliada: o dobro da largura do quadro (o que rola), cursor de reduzir e
    // rótulo dizendo o que o PRÓXIMO clique faz.
    expect(alvo.dataset.ampliada).toBe("true");
    expect(alvo.getAttribute("aria-label")).toBe("Reduzir imagem");
    expect(alvo.className).toContain("cursor-zoom-out");
    expect(imagem.dataset.ampliada).toBe("true");
    expect(imagem.className).toContain("w-[200%]");
    expect(imagem.className).not.toContain("max-h-[85vh]");

    // O zoom não é desculpa para perder a descrição da imagem.
    expect(imagem.getAttribute("alt")).toBe(ALT);
  });

  it("o segundo clique volta ao ajuste", async () => {
    const alvo = await abrirLightbox();
    const imagem = screen.getByTestId("lightbox-imagem");

    await userEvent.click(imagem);
    expect(alvo.dataset.ampliada).toBe("true");

    await userEvent.click(imagem);
    expect(alvo.dataset.ampliada).toBe("false");
    expect(alvo.getAttribute("aria-label")).toBe("Ampliar imagem");
    expect(alvo.className).toContain("cursor-zoom-in");
    expect(imagem.className).toContain("max-h-[85vh]");
    expect(imagem.className).not.toContain("w-[200%]");
  });

  it("teclado faz o mesmo: Espaço amplia e volta (o alvo é botão, não div)", async () => {
    const alvo = await abrirLightbox();

    alvo.focus();
    await userEvent.keyboard(" ");
    expect(alvo.dataset.ampliada).toBe("true");

    await userEvent.keyboard(" ");
    expect(alvo.dataset.ampliada).toBe("false");
  });

  it("Escape fecha o modal, e a próxima abertura começa ajustada", async () => {
    const alvo = await abrirLightbox();
    await userEvent.click(screen.getByTestId("lightbox-imagem"));
    expect(alvo.dataset.ampliada).toBe("true");

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByTestId("lightbox-zoom")).toBeNull();

    // Reabrir a mesma imagem não herda o zoom da vez anterior.
    await userEvent.click(miniaturaCarregada());
    expect(screen.getByTestId("lightbox-zoom").dataset.ampliada).toBe("false");
  });
});
