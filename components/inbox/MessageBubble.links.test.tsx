/**
 * LINKS NO CORPO DA MENSAGEM DO INBOX (#4576).
 *
 * O relato: endereço mandado na conversa (pelo cliente ou pela equipe) aparece
 * como texto comum — no WhatsApp o mesmo endereço é clicável. A tela antiga
 * renderizava o corpo como UMA string dentro do `<p>`; nada ali é âncora.
 *
 * Os quatro casos que a issue pede, mais dois que o conserto não pode perder:
 *
 *   1. `https://…` no meio da frase  → âncora, nova aba, `rel` seguro;
 *   2. `www.…` sem protocolo         → âncora para `https://www.…`;
 *   3. `javascript:`                 → NÃO vira link (é texto);
 *   4. mensagem sem URL              → texto puro, quebras e espaços intactos;
 *   5. legenda de mídia              → o texto ao lado do anexo também linka;
 *   6. `<b>` no corpo                → sai como TEXTO, nunca como marcação
 *      (o link é criado por código; não há `dangerouslySetInnerHTML`).
 *
 * Sem provider de idioma o `t()` degrada para a chave (pt-BR).
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { MessageBubble } from "./MessageBubble";
import type { Message } from "@/lib/types/messaging";

function msg(over: Partial<Message> = {}): Message {
  return {
    id: "m1",
    organization_id: "org1",
    conversation_id: "c1",
    channel_session_id: "s1",
    contact_id: "ct1",
    external_id: null,
    type: "text",
    direction: "inbound",
    status: "sent",
    ack: null,
    error_code: null,
    error_message: null,
    body: "corpo da mensagem",
    media_url: null,
    media_mime: null,
    media_size_bytes: null,
    media_storage_path: null,
    sent_via: "external_device",
    sent_by_user_id: null,
    sent_at: "2026-11-10T12:00:00.000Z",
    delivered_at: null,
    read_at: null,
    metadata: {},
    edited_at: null,
    revoked_at: null,
    reply_to_message_id: null,
    created_at: "2026-11-10T12:00:00.000Z",
    ...over,
  };
}

describe("MessageBubble — links no corpo (#4576)", () => {
  it("1. URL com https vira âncora que abre em nova aba com rel seguro", () => {
    const url = "https://www.domtravel.com.br/orcamento?viagem=recife";
    render(<MessageBubble message={msg({ body: `Segue o orçamento: ${url}` })} />);

    const link = screen.getByRole("link", { name: url });
    expect(link).toHaveAttribute("href", url);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(link.getAttribute("rel")).toContain("noreferrer");
    // O texto em volta continua na bolha, sem reescrita.
    expect(screen.getByText(/Segue o orçamento/)).toBeInTheDocument();
  });

  it("2. URL sem protocolo (www.) vira âncora para https://", () => {
    render(<MessageBubble message={msg({ body: "O site é www.domtravel.com.br hoje" })} />);

    const link = screen.getByRole("link", { name: "www.domtravel.com.br" });
    expect(link).toHaveAttribute("href", "https://www.domtravel.com.br");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
  });

  it("3. javascript: NÃO vira link — fica texto", () => {
    const { container } = render(
      <MessageBubble message={msg({ body: "clique javascript:alert(1) agora" })} />,
    );

    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(screen.getByText(/clique javascript:alert\(1\) agora/).textContent).toBe(
      "clique javascript:alert(1) agora",
    );
  });

  it("4. mensagem sem URL continua texto puro, com quebras e espaços intactos", () => {
    const corpo = "Bom dia,\n  volto às 14h.\n\nObrigado!";
    const { container } = render(<MessageBubble message={msg({ body: corpo })} />);

    expect(screen.queryAllByRole("link")).toHaveLength(0);
    const paragrafo = container.querySelector("p.whitespace-pre-wrap");
    expect(paragrafo?.textContent).toBe(corpo);
  });

  it("5. legenda da mensagem com mídia também tem link clicável", () => {
    render(
      <MessageBubble
        message={msg({
          type: "image",
          body: "Comprovante em https://pix.exemplo.com.br/b/123",
          media_url: "/api/v1/media/m1",
          media_mime: "image/jpeg",
          media_storage_path: "org1/m1.jpg",
        })}
      />,
    );

    const link = screen.getByRole("link", { name: "https://pix.exemplo.com.br/b/123" });
    expect(link).toHaveAttribute("href", "https://pix.exemplo.com.br/b/123");
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("6. HTML no corpo sai como texto — nada é injetado na bolha", () => {
    const { container } = render(
      <MessageBubble message={msg({ body: "<b>negrito</b> e <script>x</script>" })} />,
    );

    expect(container.querySelector("b")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByText(/<b>negrito<\/b> e <script>x<\/script>/)).toBeInTheDocument();
  });
});
