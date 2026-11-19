/**
 * A FOTO DO CONTATO no card do funil.
 *
 *  1. com foto, pede a imagem à MESMA rota da lista do Inbox;
 *  2. sem foto, não monta `<img>` (nenhum pedido que daria 404) e mostra as iniciais;
 *  3. título que é só telefone não vira iniciais de dígito.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { FotoDoContato } from "./FotoDoContato";

const CONTATO = "c0c0c0c0-c0c0-4c0c-8c0c-c0c0c0c0c0c0";

describe("FotoDoContato", () => {
  it("sem foto: nenhuma <img>, só as iniciais", () => {
    render(<FotoDoContato contactId={CONTATO} temFoto={false} nome="Ana Prado" />);

    const disco = screen.getByTestId("foto-do-contato");
    expect(disco.querySelector("img")).toBeNull();
    expect(disco.textContent).toBe("AP");
  });

  it("com foto: a fonte é a rota de avatar do contato", () => {
    // O Radix só troca para a <img> quando ela carrega; no jsdom ela nunca
    // carrega, então o que se prova aqui é o PEDIDO, pela imagem pré-carregada
    // que o Radix cria — e as iniciais seguem como rede de segurança.
    const original = window.Image;
    const pedidos: string[] = [];
    class ImagemEspia {
      set src(valor: string) {
        pedidos.push(valor);
      }
      addEventListener() {}
      removeEventListener() {}
    }
    window.Image = ImagemEspia as unknown as typeof Image;
    try {
      render(<FotoDoContato contactId={CONTATO} temFoto nome="Ana Prado" />);
    } finally {
      window.Image = original;
    }

    expect(pedidos).toContain(`/api/v1/contacts/${CONTATO}/avatar`);
    expect(screen.getByTestId("foto-do-contato").textContent).toBe("AP");
  });

  it("título que é só telefone não vira iniciais de dígito", () => {
    render(<FotoDoContato contactId={CONTATO} temFoto={false} nome="+5577981330297" />);

    expect(screen.getByTestId("foto-do-contato").textContent).toBe("");
  });
});
