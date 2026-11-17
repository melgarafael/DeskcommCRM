/**
 * LINK EM NOTA INTERNA DO INBOX (#4576).
 *
 * A issue pede o mesmo comportamento das mensagens nas notas internas: o texto
 * da nota é digitado pela equipe e é onde o endereço de um formulário, de um
 * boleto ou de um check-in aparece com mais frequência.
 *
 * A nota já parte o corpo por `partesDoCorpo` para realçar a menção (#2372);
 * este teste prende as duas coisas no MESMO parágrafo: a menção continua
 * realçada e só o endereço vira âncora — sem reescrever o resto do texto.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { NoteCard } from "./NoteCard";
import type { Note } from "@/lib/types/messaging";

function nota(over: Partial<Note> = {}): Note {
  return {
    id: "n1",
    conversation_id: "c1",
    body: "corpo da nota",
    created_by_user_id: "u1",
    created_by_name: "Ana Lima",
    created_at: "2026-11-10T12:00:00.000Z",
    media_storage_path: null,
    media_mime: null,
    media_size_bytes: null,
    media_expired_at: null,
    media_retention_days: null,
    ...over,
  } as Note;
}

describe("NoteCard — links no corpo (#4576)", () => {
  it("endereço na nota vira âncora com nova aba e rel seguro, ao lado da menção realçada", () => {
    render(
      <NoteCard
        note={nota({
          body: "@[Ana Lima](mencao:2f9c1d80-0000-0000-0000-000000000000) o boleto está em www.banco.exemplo.com.br/b/9 e vence hoje",
        })}
      />,
    );

    const link = screen.getByRole("link", { name: "www.banco.exemplo.com.br/b/9" });
    expect(link).toHaveAttribute("href", "https://www.banco.exemplo.com.br/b/9");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(link.getAttribute("rel")).toContain("noreferrer");
    // A menção continua saindo como nome realçado, não como token de banco.
    expect(screen.getByText("@Ana Lima")).toBeInTheDocument();
  });

  it("nota sem endereço continua texto puro", () => {
    const { container } = render(<NoteCard note={nota({ body: "Ligar amanhã\nàs 9h." })} />);

    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(container.querySelector("p.whitespace-pre-wrap")?.textContent).toBe(
      "Ligar amanhã\nàs 9h.",
    );
  });
});
