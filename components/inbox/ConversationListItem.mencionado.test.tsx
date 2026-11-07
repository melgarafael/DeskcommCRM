/**
 * O selo "Mencionado" na linha da lista (#2372).
 *
 * Quem foi citado numa nota interna precisa achar a conversa sem passar pelo
 * sino e sem lembrar em qual cliente foi. O selo é a única marca da lista que
 * fala do aviso — e só aparece quando a conversa está marcada de verdade.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ConversationListItem } from "./ConversationListItem";
import { conversaDeExemplo } from "./__fixtures__/conversa";

describe("ConversationListItem — selo de menção", () => {
  it("conversa marcada mostra o selo e a frase inteira no title", () => {
    render(
      <ConversationListItem
        conversation={conversaDeExemplo.conversation}
        {...conversaDeExemplo.props}
        mencionado
      />,
    );
    const selo = screen.getByTestId("selo-mencionado");
    expect(selo).toHaveTextContent("Mencionado");
    expect(selo).toHaveAttribute("title", "Você foi mencionado");
  });

  it("conversa sem marca não mostra selo nenhum", () => {
    render(
      <ConversationListItem
        conversation={conversaDeExemplo.conversation}
        {...conversaDeExemplo.props}
      />,
    );
    expect(screen.queryByTestId("selo-mencionado")).toBeNull();
  });
});
