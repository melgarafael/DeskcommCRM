/**
 * LIGHTBOX DE FOTOS — clicar abre a foto grande em janela flutuante.
 *
 * A cerca: aberto com 2 fotos mostra a primeira grande + contador "1/2",
 * e a navegação anda para a segunda. Fechado não renderiza imagem nenhuma.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LightboxDeFotos } from "@/components/fotos/LightboxDeFotos";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));

afterEach(cleanup);

const FOTOS = [{ url: "https://exemplo.test/a.jpg" }, { url: "https://exemplo.test/b.jpg" }];

describe("LightboxDeFotos", () => {
  it("fechado não mostra imagem", () => {
    render(<LightboxDeFotos fotos={FOTOS} indiceInicial={0} aberto={false} onFechar={() => {}} />);
    expect(document.querySelector("img")).toBeNull();
  });

  it("aberto mostra a foto grande com contador e navega", () => {
    render(<LightboxDeFotos fotos={FOTOS} indiceInicial={0} aberto onFechar={() => {}} />);
    const img = document.querySelector("img");
    expect(img?.getAttribute("src")).toBe("https://exemplo.test/a.jpg");
    expect(screen.getByText("1/2")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Próxima foto"));
    expect(document.querySelector("img")?.getAttribute("src")).toBe("https://exemplo.test/b.jpg");
    expect(screen.getByText("2/2")).toBeTruthy();
  });

  it("uma foto só não mostra navegação", () => {
    render(<LightboxDeFotos fotos={[FOTOS[0]!]} indiceInicial={0} aberto onFechar={() => {}} />);
    expect(document.querySelector("img")?.getAttribute("src")).toBe("https://exemplo.test/a.jpg");
    expect(screen.queryByText("1/1")).toBeNull();
  });
});
