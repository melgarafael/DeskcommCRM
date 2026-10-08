import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ImageMedia } from "@/components/inbox/media/ImageMedia";
import { StickerMedia } from "@/components/inbox/media/StickerMedia";

describe("ImageMedia", () => {
  it("renderiza a imagem apontando pro endpoint de mídia", () => {
    render(<ImageMedia messageId="m1" alt="Imagem recebida" />);
    const img = screen.getByAltText("Imagem recebida");
    expect(img).toHaveAttribute("src", "/api/v1/messages/m1/media");
  });

  it("desabilita o botão até a imagem carregar", () => {
    render(<ImageMedia messageId="m1" alt="Imagem recebida" />);
    const btn = screen.getByRole("button", { name: /ampliar imagem/i });
    expect(btn).toBeDisabled();
  });

  it("habilita o botão após a imagem carregar", () => {
    render(<ImageMedia messageId="m1" alt="Imagem recebida" />);
    const btn = screen.getByRole("button", { name: /ampliar imagem/i });
    fireEvent.load(screen.getByAltText("Imagem recebida"));
    expect(btn).not.toBeDisabled();
  });

  it("abre o lightbox ao clicar depois que carrega", () => {
    render(<ImageMedia messageId="m1" alt="Imagem recebida" />);
    fireEvent.load(screen.getByAltText("Imagem recebida"));
    fireEvent.click(screen.getByRole("button", { name: /ampliar imagem/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("mostra fallback quando a imagem falha", () => {
    render(<ImageMedia messageId="m1" alt="Imagem recebida" />);
    fireEvent.error(screen.getByAltText("Imagem recebida"));
    expect(screen.getByText("Mídia indisponível")).toBeInTheDocument();
  });
});

describe("StickerMedia", () => {
  it("renderiza skeleton enquanto carregando", () => {
    render(<StickerMedia messageId="m2" />);
    // `[data-esqueleto]`, e não `.animate-pulse`.
    //
    // A classe era a da implementação, e quando ela mudou (o esqueleto passou a
    // ser uma faixa que atravessa, em vez de um pulso de opacidade — o pulso
    // vivia entre dois contrastes e o pior deles era quase invisível) este
    // seletor deixou de casar com qualquer coisa. O caso de presença reprovou,
    // que é o certo; o de AUSÊNCIA, logo abaixo, passou a valer vácuo:
    // `not.toBeInTheDocument()` contra seletor que nunca casa passa sempre,
    // inclusive com o esqueleto preso na tela para sempre.
    //
    // O atributo é contrato do primitivo (`components/ui/skeleton.tsx`); a
    // classe é detalhe dele.
    const skeleton = document.querySelector("[data-esqueleto]");
    expect(skeleton).toBeInTheDocument();
  });

  it("renderiza a figurinha sem moldura de bolha", () => {
    render(<StickerMedia messageId="m2" />);
    const img = screen.getByAltText("Figurinha");
    expect(img).toHaveAttribute("src", "/api/v1/messages/m2/media");
  });

  it("remove skeleton após carregar", () => {
    render(<StickerMedia messageId="m2" />);
    const img = screen.getByAltText("Figurinha");
    fireEvent.load(img);
    // `[data-esqueleto]`, e não `.animate-pulse`.
    //
    // A classe era a da implementação, e quando ela mudou (o esqueleto passou a
    // ser uma faixa que atravessa, em vez de um pulso de opacidade — o pulso
    // vivia entre dois contrastes e o pior deles era quase invisível) este
    // seletor deixou de casar com qualquer coisa. O caso de presença reprovou,
    // que é o certo; o de AUSÊNCIA, logo abaixo, passou a valer vácuo:
    // `not.toBeInTheDocument()` contra seletor que nunca casa passa sempre,
    // inclusive com o esqueleto preso na tela para sempre.
    //
    // O atributo é contrato do primitivo (`components/ui/skeleton.tsx`); a
    // classe é detalhe dele.
    const skeleton = document.querySelector("[data-esqueleto]");
    expect(skeleton).not.toBeInTheDocument();
  });

  it("mostra caixa estável no erro (h-40 w-40)", () => {
    render(<StickerMedia messageId="m2" />);
    const img = screen.getByAltText("Figurinha");
    fireEvent.error(img);
    const stableBox = document.querySelector(".h-40.w-40");
    expect(stableBox).toBeInTheDocument();
    expect(screen.getByText("Mídia indisponível")).toBeInTheDocument();
  });
});
