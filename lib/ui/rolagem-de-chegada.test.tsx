import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RolagemDeChegada } from "./rolagem-de-chegada";

/**
 * O mecanismo da chegada por âncora (#4083, #3975). A medida em pixel é da prova
 * de tela; aqui fica o contrato: só rola depois da leitura de cima terminar, só
 * quando o alvo existe, uma vez, e nunca por cima de quem já rolou.
 */
const rolagem = vi.fn();

beforeEach(() => {
  rolagem.mockReset();
  window.HTMLElement.prototype.scrollIntoView = rolagem;
  window.matchMedia = vi.fn().mockReturnValue({ matches: false }) as unknown as typeof window.matchMedia;
  Object.defineProperty(window, "scrollY", { value: 0, configurable: true });
});
afterEach(() => {
  document.body.innerHTML = "";
});

function alvo(id: string) {
  const el = document.createElement("button");
  el.id = id;
  document.body.appendChild(el);
  return el;
}

describe("RolagemDeChegada", () => {
  it("espera a leitura de cima terminar antes de rolar", () => {
    alvo("cases_enabled");
    const aoTerminar = vi.fn();
    const { rerender } = render(
      <RolagemDeChegada ancora="cases_enabled" scrollY={0} esperando aoTerminar={aoTerminar} />,
    );
    expect(rolagem).not.toHaveBeenCalled();
    rerender(<RolagemDeChegada ancora="cases_enabled" scrollY={0} esperando={false} aoTerminar={aoTerminar} />);
    expect(rolagem).toHaveBeenCalledTimes(1);
    expect(rolagem).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
    expect(aoTerminar).toHaveBeenCalledTimes(1);
  });

  it("espera o alvo aparecer no DOM", async () => {
    const aoTerminar = vi.fn();
    render(<RolagemDeChegada ancora="cases_enabled" scrollY={0} esperando={false} aoTerminar={aoTerminar} />);
    expect(rolagem).not.toHaveBeenCalled();
    await act(async () => {
      alvo("cases_enabled");
      await Promise.resolve();
    });
    expect(rolagem).toHaveBeenCalledTimes(1);
    expect(aoTerminar).toHaveBeenCalledTimes(1);
  });

  it("não rola por cima de quem rolou enquanto carregava, mas sai de cena", () => {
    alvo("cases_enabled");
    Object.defineProperty(window, "scrollY", { value: 300, configurable: true });
    const aoTerminar = vi.fn();
    render(<RolagemDeChegada ancora="cases_enabled" scrollY={0} esperando={false} aoTerminar={aoTerminar} />);
    expect(rolagem).not.toHaveBeenCalled();
    expect(aoTerminar).toHaveBeenCalledTimes(1);
  });

  it("respeita quem pediu menos movimento", () => {
    alvo("cases_enabled");
    window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as unknown as typeof window.matchMedia;
    render(<RolagemDeChegada ancora="cases_enabled" scrollY={0} esperando={false} aoTerminar={vi.fn()} />);
    expect(rolagem).toHaveBeenCalledWith({ behavior: "auto", block: "start" });
  });
});
