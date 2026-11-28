/**
 * A ETIQUETA COMPRIDA FICA NUMA LINHA SÓ NA LISTA DO INBOX (#5364).
 *
 * ─── O defeito ──────────────────────────────────────────────────────────────
 *
 * O chip da lista tem altura FIXA (`h-4`) e não tinha teto de largura. Com um
 * nome comprido o texto quebrava dentro do chip — a caixa não cresce em altura,
 * então as linhas de texto vazavam por cima do chip vizinho. Com as quatro
 * etiquetas que a faixa aceita desde a #5212, o defeito aparece mais.
 *
 * ─── O que este arquivo pode e o que ele NÃO pode provar ─────────────────────
 *
 * jsdom não faz layout: `scrollWidth`, `clientWidth` e `getBoundingClientRect`
 * medem zero, e um teste que "medisse" sobreposição aqui estaria medindo o
 * próprio zero. O que se prende é o CONTRATO DE CSS que faz o corte acontecer —
 * `truncate` (uma linha + reticências), `min-w-0` (o item de flex pode encolher
 * abaixo do conteúdo, em vez de empurrar o vizinho) e um `max-w` explícito (o
 * teto que dá ao `truncate` uma largura para cortar). O que só a tela prova é o
 * desenho: as reticências aparecendo e um chip não encostando no outro em 320,
 * 375, 390 e 1280 — isso é prova do mantenedor, não deste arquivo.
 *
 * O `title` com o nome inteiro é o que não pode faltar: é a única forma de ler
 * a etiqueta que o corte esconde, sem abrir a conversa.
 *
 * A altura da linha NÃO muda (`h-4` continua lá): o corte é na largura.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ConversationListItem } from "@/components/inbox/ConversationListItem";
import { conversaDeExemplo } from "@/components/inbox/__fixtures__/conversa";

/** Nome bem acima do que cabe em 9rem com `text-[10px]` — o caso da issue. */
const COMPRIDA = "Aguardando retorno do financeiro";
const OUTRA_COMPRIDA = "Cliente pediu boleto por WhatsApp";

function conversaComEtiquetas(tags: string[]) {
  const base = conversaDeExemplo.conversation;
  return { ...base, tags: [], contacts: { ...base.contacts!, tags } };
}

/** O chip é o próprio texto: é ele que carrega as classes e o `title`. */
function chip(nome: string): HTMLElement {
  return screen.getByText(nome);
}

describe("lista do Inbox — etiqueta comprida numa linha só (#5364)", () => {
  it("o chip corta com reticências: `truncate` + `min-w-0` + `max-w`", () => {
    render(<ConversationListItem conversation={conversaComEtiquetas([COMPRIDA])} {...conversaDeExemplo.props} />);

    const el = chip(COMPRIDA);
    // `truncate` é o par que impede a quebra: `overflow-hidden` +
    // `text-overflow-ellipsis` + `white-space-nowrap`.
    expect(el.className).toContain("truncate");
    // Sem `min-w-0` o item de flex tem piso no conteúdo: o `max-w` não segura e
    // o chip empurra o vizinho. É o outro lado do defeito da issue.
    expect(el.className).toContain("min-w-0");
    // O teto que dá ao `truncate` uma largura para cortar — qualquer `max-w`
    // definido serve; `max-w-none` é a ausência dele com outro nome.
    expect(el.className).toMatch(/\bmax-w-/);
    expect(el.className).not.toContain("max-w-none");
    // O texto não pode voltar a quebrar por uma classe de quebra explícita.
    expect(el.className).not.toContain("whitespace-normal");
    expect(el.className).not.toContain("break-words");
    // Container flex não desenha reticências: o chip tem de ser de bloco.
    expect(el.className).toContain("inline-block");
    expect(el.className).not.toMatch(/\binline-flex\b/);
  });

  it("a altura da linha não muda: o chip continua `h-4`", () => {
    render(<ConversationListItem conversation={conversaComEtiquetas([COMPRIDA])} {...conversaDeExemplo.props} />);

    const el = chip(COMPRIDA);
    // O conserto é de LARGURA. Crescer o chip para caber o nome inteiro
    // desalinharia a faixa de selos, que divide a linha com canal e atendente.
    expect(el.className).toContain("h-4");
    expect(el.className).not.toContain("h-auto");
  });

  it("o nome inteiro fica no `title`, mesmo com o texto cortado", () => {
    render(<ConversationListItem conversation={conversaComEtiquetas([COMPRIDA])} {...conversaDeExemplo.props} />);

    // O mesmo elemento: o `title` mora no chip, não num irmão.
    expect(chip(COMPRIDA)).toBe(screen.getByTitle(COMPRIDA));
  });

  it("com 4 etiquetas compridas na faixa, TODAS cortam e todas têm o nome no `title`", () => {
    const quatro = [COMPRIDA, OUTRA_COMPRIDA, "Orçamento enviado sem resposta", "Retorno da vistoria do imóvel"];
    render(<ConversationListItem conversation={conversaComEtiquetas(quatro)} {...conversaDeExemplo.props} />);

    for (const nome of quatro) {
      const el = chip(nome);
      expect(el.className).toContain("truncate");
      expect(el.className).toMatch(/\bmax-w-/);
      expect(el.getAttribute("title")).toBe(nome);
    }
  });

  it("a etiqueta curta ganha o mesmo tratamento — a régua é do chip, não do nome", () => {
    // Se o corte dependesse do tamanho do texto, a próxima etiqueta longa
    // nascida no produto voltaria a quebrar sem ninguém tocar no componente.
    render(<ConversationListItem conversation={conversaComEtiquetas(["vip"])} {...conversaDeExemplo.props} />);

    const el = chip("vip");
    expect(el.className).toContain("truncate");
    expect(el.className).toMatch(/\bmax-w-/);
    expect(el.getAttribute("title")).toBe("vip");
  });
});
