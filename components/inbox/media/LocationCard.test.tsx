/**
 * O cartão do pino mostra à equipe o endereço aproximado que o Google deu
 * (chave de Mapas, 0504) — e, sem ele, o mesmo "Localização compartilhada" de antes.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { LocationCard } from "./LocationCard";

describe("LocationCard", () => {
  it("com endereço aproximado: rua, cidade e estado, marcados (aprox.)", () => {
    render(
      <LocationCard
        localizacao={{ latitude: -25.43, longitude: -49.27, aproximado: { rua: "Rua XV de Novembro", cidade: "Curitiba", regiao: "Paraná" } }}
      />,
    );
    expect(screen.getByTestId("pino-detalhe").textContent).toBe("Rua XV de Novembro, Curitiba, Paraná (aprox.)");
  });

  it("o nome que o cliente escolheu no WhatsApp vem antes do aproximado — é exato", () => {
    render(<LocationCard localizacao={{ latitude: -23.55, longitude: -46.63, nome: "Praça da Matriz", aproximado: { cidade: "São Paulo" } }} />);
    expect(screen.getByTestId("pino-detalhe").textContent).toBe("Praça da Matriz");
  });

  it("controle: só coordenadas, o texto de sempre", () => {
    render(<LocationCard localizacao={{ latitude: -23.55, longitude: -46.63 }} />);
    expect(screen.getByTestId("pino-detalhe").textContent).toBe("Localização compartilhada");
  });
});
