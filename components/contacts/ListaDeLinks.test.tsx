/**
 * A lista de links do contato (apresentação): um botão por rede, com `href`
 * correto, aba nova e `rel` seguro; lista vazia não renderiza nada; e um
 * `javascript:` não vira `href`, nem quando chega direto à tela.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { linksParaExibir } from "@/lib/leads/links-de-contato";

import { ListaDeLinks } from "./ListaDeLinks";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));

describe("ListaDeLinks", () => {
  it("renderiza um link por rede, com href, aba nova e rel seguro", () => {
    render(
      <ListaDeLinks
        links={[
          { tipo: "instagram", href: "https://www.instagram.com/loja" },
          { tipo: "site", href: "https://exemplo.com.br/" },
        ]}
      />,
    );

    const instagram = screen.getByRole("link", { name: "Abrir Instagram" });
    expect(instagram).toHaveAttribute("href", "https://www.instagram.com/loja");
    expect(instagram).toHaveAttribute("target", "_blank");
    expect(instagram).toHaveAttribute("rel", "noopener noreferrer");
    expect(instagram).toHaveTextContent("IG");
    expect(screen.getByRole("link", { name: "Abrir Site" })).toHaveAttribute(
      "href",
      "https://exemplo.com.br/",
    );
  });

  it("lista vazia não renderiza nada", () => {
    const { container } = render(<ListaDeLinks links={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("⭐ javascript: gravado no custom_fields não vira href (a leitura descarta antes da tela)", () => {
    const { container } = render(
      <ListaDeLinks links={linksParaExibir({ link_site: "javascript:alert(1)" })} />,
    );

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });

  it("⭐ defesa própria: mesmo sem a leitura, javascript: não vira link clicável", () => {
    render(
      <ListaDeLinks
        links={[
          { tipo: "site", href: "javascript:alert(1)" },
          { tipo: "instagram", href: "https://www.instagram.com/loja" },
        ]}
      />,
    );

    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "https://www.instagram.com/loja");
  });

  it("aoClicarNoLink recebe o clique (é o gancho do card para o stopPropagation)", () => {
    const aoClicar = vi.fn();
    render(
      <ListaDeLinks
        links={[{ tipo: "site", href: "https://exemplo.com.br/" }]}
        aoClicarNoLink={aoClicar}
      />,
    );

    fireEvent.click(screen.getByRole("link", { name: "Abrir Site" }));

    expect(aoClicar).toHaveBeenCalledTimes(1);
  });
});
