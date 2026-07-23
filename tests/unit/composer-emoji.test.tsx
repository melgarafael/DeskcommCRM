import { fireEvent, render, screen } from "@testing-library/react";
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
  it("abre o picker ao clicar e propaga o emoji escolhido", async () => {
    const onPick = vi.fn();
    render(<EmojiButton onPick={onPick} />);
    fireEvent.click(screen.getByRole("button", { name: /emoji/i }));
    fireEvent.click(await screen.findByText("picker-fake"));
    expect(onPick).toHaveBeenCalledWith("😀");
  });
});
