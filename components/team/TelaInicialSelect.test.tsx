import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { TelaInicialSelect } from "./TelaInicialSelect";

/**
 * #4864 — o seletor de tela inicial.
 *
 * O que ele NÃO pode fazer é oferecer uma porta que a entrada vai descartar:
 * a lista sai das portas visíveis (`destinosDaInterface`), não do catálogo
 * inteiro. Esse é o defeito que a tela teria de graça se fosse populada com
 * `NAV_CATALOG`: escolher, salvar, e continuar caindo no Inbox sem entender.
 */
describe("TelaInicialSelect", () => {
  it("oferece só as portas visíveis, mais o padrão do sistema", () => {
    render(
      <TelaInicialSelect
        value={undefined}
        onChange={vi.fn()}
        role="admin"
        visiveis={{ preset: "completa", destinos: ["/app/tasks"] }}
      />,
    );
    const select = screen.getByTestId("tela-inicial");
    const opcoes = within(select).getAllByRole("option").map((o) => o.getAttribute("value"));
    expect(opcoes[0]).toBe("");
    expect(opcoes).toContain("/app/tasks");
    // O Kanban está no catálogo, mas fora do menu desta empresa: não é opção.
    expect(opcoes).not.toContain("/app/kanban");
    // Essenciais não viram entrada: já estão sempre disponíveis.
    expect(opcoes).not.toContain("/app/settings/profile");
    expect(opcoes).not.toContain("/app/team");
  });

  it("escolha fora da lista aparece como padrão, não como porta fantasma", () => {
    render(
      <TelaInicialSelect
        value="/app/kanban"
        onChange={vi.fn()}
        role="admin"
        visiveis={{ preset: "completa", destinos: ["/app/tasks"] }}
      />,
    );
    expect((screen.getByTestId("tela-inicial") as HTMLSelectElement).value).toBe("");
    expect(screen.getByRole("option", { name: "Padrão do sistema" })).toBeTruthy();
  });

  it("devolve o href escolhido e a ausência quando volta ao padrão", async () => {
    const onChange = vi.fn();
    render(
      <TelaInicialSelect
        value="/app/tasks"
        onChange={onChange}
        role="admin"
        visiveis={{ preset: "completa", destinos: ["/app/tasks", "/app/kanban"] }}
      />,
    );
    await userEvent.selectOptions(screen.getByTestId("tela-inicial"), "/app/kanban");
    expect(onChange).toHaveBeenLastCalledWith("/app/kanban");
    await userEvent.selectOptions(screen.getByTestId("tela-inicial"), "");
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });
});
