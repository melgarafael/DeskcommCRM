/**
 * O destino do interesse cujo funil foi ARQUIVADO depois de salvo (Spec 25, R5b).
 *
 * Medido na prova de tela do #3328: a lista de funis só traz os vivos, então o
 * seletor exibia "Sem funil (passar para a equipe)" enquanto o banco guardava o
 * funil arquivado, a etapa seguia habilitada e salvar dava 422. A tela tem de
 * dizer o que está gravado.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { DestinoDoInteresse } from "./DestinoDoInteresse";

const VIVO = "11111111-1111-4111-8111-111111111111";
const ARQUIVADO = "22222222-2222-4222-8222-222222222222";
const ETAPA = "33333333-3333-4333-8333-333333333333";

vi.mock("@/hooks/campanhas/useDestinoDaCampanha", () => ({
  useFunis: () => ({ data: [{ id: VIVO, name: "Pedidos" }] }),
  useEtapas: () => ({ data: [{ id: ETAPA, name: "Novo", is_won: false, is_lost: false }] }),
}));

afterEach(() => cleanup());

describe("DestinoDoInteresse com o funil arquivado", () => {
  it("mostra 'Funil arquivado', trava a etapa e explica o que fazer", () => {
    render(<DestinoDoInteresse valor={{ pipeline_id: ARQUIVADO, stage_id: ETAPA }} onChange={() => {}} />);
    const funil = screen.getByLabelText("Funil do interesse") as HTMLSelectElement;
    expect(funil.value).toBe(ARQUIVADO);
    expect(funil.selectedOptions[0]?.textContent).toBe("Funil arquivado");
    expect((screen.getByLabelText("Etapa do interesse") as HTMLSelectElement).disabled).toBe(true);
    expect(screen.getByText(/O funil escolhido foi arquivado/)).toBeTruthy();
  });

  it("controle: com o funil vivo, nada de aviso de arquivado", () => {
    render(<DestinoDoInteresse valor={{ pipeline_id: VIVO, stage_id: ETAPA }} onChange={() => {}} />);
    const funil = screen.getByLabelText("Funil do interesse") as HTMLSelectElement;
    expect(funil.selectedOptions[0]?.textContent).toBe("Pedidos");
    expect((screen.getByLabelText("Etapa do interesse") as HTMLSelectElement).disabled).toBe(false);
    expect(screen.queryByText(/O funil escolhido foi arquivado/)).toBeNull();
  });
});
