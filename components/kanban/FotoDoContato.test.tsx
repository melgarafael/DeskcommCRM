/**
 * A FOTO DO CONTATO no card do funil (revisão do #5007).
 *
 *  1. é uma `<img>` NATIVA com `loading="lazy"`: só os cards na tela pedem a
 *     foto. O `AvatarImage` do Radix pré-carregava com `new Image()` para todo
 *     card montado — o caso 1 reprova se esse pré-carregamento voltar;
 *  2. a fonte é a rota de avatar do contato, a mesma do Inbox;
 *  3. imagem que falha some: nunca ícone quebrado no card;
 *  4. o card só monta a foto quando o quadro disse que HÁ foto — sem foto, nenhum
 *     disco ao lado do disco do responsável.
 */
import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { FotoDoContato } from "./FotoDoContato";

const CONTATO = "c0c0c0c0-c0c0-4c0c-8c0c-c0c0c0c0c0c0";
const IMAGEM_ORIGINAL = window.Image;

afterEach(() => {
  window.Image = IMAGEM_ORIGINAL;
});

describe("FotoDoContato", () => {
  it("é uma <img> preguiçosa, sem pré-carregamento por new Image()", () => {
    let preCarregadas = 0;
    window.Image = class {
      constructor() {
        preCarregadas++;
      }
    } as unknown as typeof Image;

    render(<FotoDoContato contactId={CONTATO} />);

    const foto = screen.getByTestId("foto-do-contato") as HTMLImageElement;
    expect(foto.tagName).toBe("IMG");
    expect(foto.getAttribute("loading")).toBe("lazy");
    expect(foto.getAttribute("decoding")).toBe("async");
    expect(preCarregadas, "algo voltou a pré-carregar a foto de todo card").toBe(0);
  });

  it("a fonte é a rota de avatar do contato, a mesma do Inbox", () => {
    render(<FotoDoContato contactId={CONTATO} />);

    expect(screen.getByTestId("foto-do-contato").getAttribute("src")).toBe(
      `/api/v1/contacts/${CONTATO}/avatar`,
    );
  });

  it("imagem que falha some do card", () => {
    render(<FotoDoContato contactId={CONTATO} />);

    fireEvent.error(screen.getByTestId("foto-do-contato"));

    expect(screen.queryByTestId("foto-do-contato")).toBeNull();
  });
});
