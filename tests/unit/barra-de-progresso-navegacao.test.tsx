/**
 * A barra de progresso da navegação.
 *
 * ─── Por que o `<a>` cru, e não `<Link>` ───────────────────────────────────
 *
 * O `@next/next/no-html-link-for-pages` existe para impedir que uma PÁGINA
 * navegue com âncora crua e perca o roteamento do cliente. Aqui ele mede a
 * coisa errada: a peça sob teste é um ouvinte de `click` no `document`, e o
 * contrato dela é justamente reagir a QUALQUER âncora da árvore — inclusive as
 * que o `<Link>` renderiza, que no DOM são exatamente isto. Trocar por `<Link>`
 * traria um roteador de mentira para dentro do caso e mediria o mock, não o
 * ouvinte. O desligamento é do arquivo porque todo caso aqui monta o mesmo
 * fixture; ele NÃO vale para nada fora de `tests/`.
 */
/* eslint-disable @next/next/no-html-link-for-pages */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { BarraDeProgressoNavegacao } from "@/components/shell/BarraDeProgressoNavegacao";

let mockPathname = "/app/inbox";
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
  useSearchParams: () => new URLSearchParams(),
}));

describe("BarraDeProgressoNavegacao", () => {
  afterEach(() => {
    cleanup();
    mockPathname = "/app/inbox";
  });

  it("permanece oculta na montagem inicial", () => {
    const { container } = render(<BarraDeProgressoNavegacao />);
    expect(container.firstChild).toBeNull();
  });

  it("ativa imediatamente no clique em um link para outra rota interna", () => {
    const { container } = render(
      <div>
        <BarraDeProgressoNavegacao />
        <a href="/app/contacts">Contatos</a>
      </div>,
    );

    const link = screen.getByText("Contatos");
    fireEvent.click(link);

    const barra = container.querySelector("[aria-hidden='true']");
    expect(barra).not.toBeNull();
  });

  it("não ativa ao clicar em link para a mesma rota atual", () => {
    const { container } = render(
      <div>
        <BarraDeProgressoNavegacao />
        <a href="/app/inbox">Inbox Atual</a>
      </div>,
    );

    const link = screen.getByText("Inbox Atual");
    fireEvent.click(link);

    const barra = container.querySelector("[aria-hidden='true']");
    expect(barra).toBeNull();
  });

  it("continua sabendo onde está DEPOIS de navegar", () => {
    // O caso acima passa verde mesmo com a rota congelada no primeiro render —
    // porque no primeiro render ela está certa. O defeito só aparece a partir da
    // SEGUNDA rota: o ouvinte do `document` é registrado uma vez (`[]`) e, se a
    // comparação ler o `pathname` da closure, ela mede contra uma rota que o
    // usuário já deixou. Efeito: clicar no link da página em que você já está
    // acende a barra — e uma barra que acende sempre não informa nada.
    // Cada render monta um elemento NOVO de propósito: reaproveitar a mesma
    // referência faz o React pular a renderização, e aí o teste passaria verde
    // sem nunca ter simulado a navegação (foi o primeiro jeito que escrevi).
    const arvore = () => (
      <div>
        <BarraDeProgressoNavegacao />
        <a href="/app/contacts">Contatos</a>
      </div>
    );
    const { container, rerender } = render(arvore());

    mockPathname = "/app/contacts";
    rerender(arvore());

    fireEvent.click(screen.getByText("Contatos"));

    expect(
      container.querySelector("[aria-hidden='true']"),
      "a barra acendeu para a rota em que o usuário já está",
    ).toBeNull();
  });
});
