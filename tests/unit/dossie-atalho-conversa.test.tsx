import { readFileSync } from "node:fs";

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * A PORTA PARA A CONVERSA, DENTRO DO DOSSIÊ.
 *
 * ─── O defeito, relatado olhando a tela ─────────────────────────────────────
 *
 * O atalho do card existe e funciona. Mas o usuário foi procurá-lo no DOSSIÊ —
 * que é para onde se vai quando a pergunta é "o que está acontecendo com este
 * negócio?" — e lá a linha do tempo ANUNCIA "Entrou no funil / primeira
 * mensagem recebida no WhatsApp" sem oferecer nenhum jeito de abrir a conversa.
 *
 * Anunciar o canal e não dar a porta é pior que não anunciar: quem lê procura,
 * não acha, e sai para caçar a conversa na mão. Era um `grep` de distância:
 * `LeadDossier.tsx` tinha ZERO referências ao inbox.
 */
import { ConversaNoDossie } from "@/components/kanban/ConversaNoDossie";

vi.mock("next/link", () => ({
  default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...p}>
      {children}
    </a>
  ),
}));

const conversa = {
  id: "conv-1",
  preview: "Gracias 🤝",
  last_message_at: "2026-08-10T15:56:00Z",
  unread: 3,
};

describe("a porta para a conversa", () => {
  it("aponta para a conversa CERTA, não para o inbox genérico", () => {
    // `/app/inbox` sozinho devolveria o usuário à lista para procurar de novo —
    // que é exatamente o trabalho que este bloco existe para evitar.
    render(<ConversaNoDossie conversa={conversa} />);
    expect(screen.getByRole("link")).toHaveAttribute("href", "/app/inbox?id=conv-1");
  });

  it("mostra a última mensagem — senão o clique é uma aposta", () => {
    render(<ConversaNoDossie conversa={conversa} />);
    expect(screen.getByText("Gracias 🤝")).toBeInTheDocument();
  });

  it("mostra o NÚMERO de não lidas, não um ponto", () => {
    // "3 sem ler" e "12 sem ler" pedem urgências diferentes.
    render(<ConversaNoDossie conversa={conversa} />);
    expect(screen.getByLabelText("3 sem ler")).toHaveTextContent("3");
  });

  it("sem não lidas não inventa um zero", () => {
    render(<ConversaNoDossie conversa={{ ...conversa, unread: 0 }} />);
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("conversa sem prévia ainda abre — o texto é extra, o destino é o ponto", () => {
    render(<ConversaNoDossie conversa={{ ...conversa, preview: null }} />);
    expect(screen.getByRole("link")).toHaveAttribute("href", "/app/inbox?id=conv-1");
  });

  it("negócio SEM conversa não renderiza nada", () => {
    // Criado à mão ou por webhook: estado normal, não erro. Um "sem conversa"
    // cinza ocuparia o mesmo espaço para não dizer nada.
    const { container } = render(<ConversaNoDossie conversa={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("o elo que some sem barulho", () => {
  it("o dossiê MONTA o bloco — o componente sozinho não abre porta nenhuma", () => {
    // O defeito original não era o componente faltando: era o dossiê não o
    // chamar. Um teste que só exercitasse `ConversaNoDossie` ficaria verde com
    // a tela exatamente como o usuário a encontrou.
    const fonte = readFileSync("components/kanban/LeadDossier.tsx", "utf8");
    expect(fonte, "o dossiê não monta o bloco da conversa").toMatch(
      /<ConversaNoDossie\s+conversa=\{lead\.conversa\}/,
    );
  });

  it("e o bloco vem ANTES da linha do tempo que anuncia o canal", () => {
    // É a timeline que diz "Entrou no funil". A porta atrás do anúncio
    // obrigaria a rolar para achar o que o próprio texto acabou de prometer.
    const fonte = readFileSync("components/kanban/LeadDossier.tsx", "utf8");
    expect(fonte.indexOf("<ConversaNoDossie")).toBeLessThan(fonte.indexOf("<LeadTimeline"));
  });
});
