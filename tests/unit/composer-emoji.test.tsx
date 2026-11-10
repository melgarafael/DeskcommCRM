import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

// emoji-mart real é pesado p/ jsdom — mocka o módulo dinâmico com um picker fake.
vi.mock("@emoji-mart/react", () => ({
  default: ({ onEmojiSelect }: { onEmojiSelect: (e: { native: string }) => void }) => (
    <button type="button" onClick={() => onEmojiSelect({ native: "😀" })}>
      picker-fake
    </button>
  ),
}));
vi.mock("@emoji-mart/data", () => ({ default: {} }));

import { EmojiButton } from "@/components/inbox/composer/EmojiButton";

describe("EmojiButton", () => {
  // #3268: mesma prova do ícone de anexos, agora no emoji — hover no botão,
  // papel `tooltip` e o rótulo DAQUELE ícone.
  it("passar o mouse no ícone de emoji mostra a dica com o rótulo daquele ícone", async () => {
    const user = userEvent.setup();
    render(<EmojiButton onPick={vi.fn()} />);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    await user.hover(screen.getByRole("button", { name: /emoji/i }));

    const dica = await screen.findByRole("tooltip", {}, { timeout: 2000 });
    expect(dica).toHaveTextContent("Emoji");
    // Rótulo DAQUELE ícone: a dica de anexos não vaza para cá.
    expect(dica).not.toHaveTextContent("Anexar");
  });

  it("abre o picker ao clicar e propaga o emoji escolhido", async () => {
    const onPick = vi.fn();
    render(<EmojiButton onPick={onPick} />);
    fireEvent.click(screen.getByRole("button", { name: /emoji/i }));
    fireEvent.click(await screen.findByText("picker-fake"));
    expect(onPick).toHaveBeenCalledWith("😀");
  });
});
