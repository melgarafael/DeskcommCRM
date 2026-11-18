import { expect, it, vi, beforeEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MessageBubble, colunasDoSeletorDeReacao } from "./MessageBubble";
import type { Message } from "@/lib/types/messaging";

vi.mock("@emoji-mart/react", () => ({
  default: ({ onEmojiSelect }: { onEmojiSelect: (e: { native: string }) => void }) =>
    <button type="button" onClick={() => onEmojiSelect({ native: "🤩" })}>Escolher 🤩</button>,
}));

const message = {
  id: "m1", type: "text", body: "Olá", direction: "inbound", status: "sent",
  sent_at: "2026-09-08T12:00:00Z", created_at: "2026-09-08T12:00:00Z",
  sent_via: "external_device", metadata: {},
} as Message;

beforeEach(() => localStorage.clear());

it("mostra os cinco mais usados antes do modal e atualiza após reagir", async () => {
  const user = userEvent.setup();
  const onReagir = vi.fn(async () => undefined);
  const { unmount } = render(<MessageBubble message={message} onReagir={onReagir} />);
  await user.click(screen.getByRole("button", { name: "Opções da mensagem" }));
  expect(screen.getAllByRole("menuitem", { name: /^Reagir com / })).toHaveLength(5);
  await user.click(screen.getByRole("menuitem", { name: "Mais emojis" }));
  await user.click(await screen.findByRole("button", { name: "Escolher 🤩" }));
  unmount();
  render(<MessageBubble message={message} onReagir={onReagir} />);
  await user.click(screen.getByRole("button", { name: "Opções da mensagem" }));
  expect(screen.getAllByRole("menuitem", { name: /^Reagir com / })[0]).toHaveAccessibleName("Reagir com 🤩");
});

it("abre seletor completo e só exibe emoji após confirmação do servidor", async () => {
  const user = userEvent.setup();
  let confirmar!: () => void;
  const onReagir = vi.fn(() => new Promise<void>((resolve) => { confirmar = resolve; }));
  const { rerender } = render(<MessageBubble message={message} onReagir={onReagir} />);
  await user.click(screen.getByRole("button", { name: "Opções da mensagem" }));
  expect(screen.getAllByRole("menuitem", { name: /^Reagir com / })).toHaveLength(5);
  await user.click(screen.getByRole("menuitem", { name: "Mais emojis" }));
  expect(screen.getByRole("dialog", { name: "Escolha uma reação" })).toBeInTheDocument();
  await user.click(await screen.findByRole("button", { name: "Escolher 🤩" }));
  expect(onReagir).toHaveBeenCalledWith("🤩");
  expect(screen.queryByRole("dialog", { name: "Escolha uma reação" })).not.toBeInTheDocument();
  expect(screen.queryByTestId("message-reactions")).not.toBeInTheDocument();
  await act(async () => { confirmar(); });
  rerender(<MessageBubble message={message} onReagir={onReagir} reacoes={[{ emoji: "🤩", direction: "outbound" }]} />);
  expect(screen.getByTestId("message-reactions")).toHaveTextContent("🤩");
});

// Medido na prova pela tela do #4194: a 375px o seletor de 9 colunas (352px) vazava
// 22px pela borda do modal. Largura do emoji-mart = colunas × 36 + 28; área útil do
// modal = janela − 58.
it("o seletor de reações cabe no modal em telas estreitas e tem 9 colunas nas largas", () => {
  for (const janela of [320, 360, 375, 390, 414, 640, 1280]) {
    const colunas = colunasDoSeletorDeReacao(janela);
    expect(colunas * 36 + 28, `janela ${janela}px`).toBeLessThanOrEqual(janela - 58);
  }
  expect(colunasDoSeletorDeReacao(375)).toBe(8);
  expect(colunasDoSeletorDeReacao(1280)).toBe(9);
});
