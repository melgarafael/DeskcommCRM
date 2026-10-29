// components/kanban/AtalhosDoCard.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AtalhosDoNegocio } from "./AtalhosDoCard";

/**
 * OS ATALHOS DO CARD NA TELA (issue #3487).
 *
 * ─── O que só este arquivo prova ────────────────────────────────────────────
 *
 * `lib/leads/atalhos-do-card.test.ts` prova a régua (`atalhosParaExibir` devolve
 * ou não o href). Aqui a pergunta é outra, e é a que o navegador responde:
 * **existe `<a href>` no DOM?** É a diferença entre "o domínio recusou" e "a
 * tela não desenhou" — as duas são necessárias, e um `dangerouslySetInnerHTML`,
 * um `href` montado à mão ou um `map` que ignora a lista filtrada quebrariam
 * esta última sem tocar na primeira.
 *
 * ─── O contato é dublê, de propósito ───────────────────────────────────────
 *
 * O `useContact` faz GET em `/api/v1/contacts/{id}`. Substituí-lo isola o
 * objeto do teste (o que a faixa desenha) do transporte — que tem teste próprio
 * — e torna medível o estado que interessa: contato SEM telefone, SEM e-mail,
 * SEM documento.
 */

const contato = vi.hoisted(() => ({
  atual: null as Record<string, unknown> | null,
}));

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));
vi.mock("@/hooks/contacts/useContact", () => ({
  useContact: () => ({ data: contato.atual ? { data: contato.atual } : undefined }),
}));

function comContato(campos: Record<string, unknown> | null) {
  contato.atual = {
    id: "contato-1",
    name: "Maria Silva",
    display_name: null,
    phone_number: "+55 11 99999-9999",
    email: "maria@exemplo.com",
    custom_fields: campos ?? {},
  };
}

const ATALHOS = [
  { rotulo: "Ligar", icone: "telefone" as const, url: "tel:{{telefone}}" },
  {
    rotulo: "Tirar pedido",
    icone: "carrinho" as const,
    url: "https://pedidos.exemplo.com/?cliente={{erp_id}}",
  },
];

const NEGOCIO = { id: "lead-1", custom_fields: { erp_id: "ERP-4471" } };

describe("AtalhosDoNegocio — a faixa de botões do card", () => {
  it("desenha os botões com o href montado e o `tel:` sem espaço", () => {
    comContato({});
    render(<AtalhosDoNegocio atalhos={ATALHOS} lead={NEGOCIO} contactId="contato-1" />);

    const ligar = screen.getByRole("link", { name: /Ligar/ });
    expect(ligar).toHaveAttribute("href", "tel:+5511999999999");
    // `tel:` entrega o clique ao softphone: não é aba nova.
    expect(ligar).not.toHaveAttribute("target");

    const pedido = screen.getByRole("link", { name: /Tirar pedido/ });
    expect(pedido).toHaveAttribute("href", "https://pedidos.exemplo.com/?cliente=ERP-4471");
    expect(pedido).toHaveAttribute("target", "_blank");
    expect(pedido).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("`javascript:` gravado por fora NÃO vira link na tela", () => {
    comContato({});
    const { container } = render(
      <AtalhosDoNegocio
        atalhos={[{ rotulo: "Armadilha", icone: "link", url: "javascript:alert(1)" }]}
        lead={NEGOCIO}
        contactId="contato-1"
      />,
    );
    expect(container.querySelector("a")).toBeNull();
    expect(screen.queryByTestId("atalhos-do-negocio")).toBeNull();
  });

  it("botão sem o dado NÃO aparece — nem desabilitado, nem vazio", () => {
    // Contato sem telefone: `Ligar` some; `Tirar pedido` fica, porque o ERP está
    // no negócio.
    contato.atual = {
      id: "contato-1",
      name: "Maria Silva",
      display_name: null,
      phone_number: null,
      email: null,
      custom_fields: {},
    };
    render(<AtalhosDoNegocio atalhos={ATALHOS} lead={NEGOCIO} contactId="contato-1" />);

    expect(screen.queryByRole("link", { name: /Ligar/ })).toBeNull();
    expect(screen.getByRole("link", { name: /Tirar pedido/ })).toBeInTheDocument();
  });

  it("sem NENHUM dado resolvível, a faixa não existe no DOM", () => {
    contato.atual = {
      id: "contato-1",
      name: null,
      display_name: null,
      phone_number: null,
      email: null,
      custom_fields: {},
    };
    const { container } = render(
      <AtalhosDoNegocio atalhos={ATALHOS} lead={null} contactId="contato-1" />,
    );
    expect(container.querySelector("a")).toBeNull();
    expect(container.innerHTML).toBe("");
  });

  it("funil sem atalho não busca contato nem desenha nada", () => {
    contato.atual = null;
    const { container } = render(
      <AtalhosDoNegocio atalhos={[]} lead={NEGOCIO} contactId="contato-1" />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("`{{documento}}` vem do campo do contato; sem ele o botão não aparece", () => {
    comContato({ cpf: "123.456.789-09" });
    const boleto = [
      { rotulo: "Segunda via", icone: "boleto" as const, url: "https://fin.exemplo.com/?doc={{documento}}" },
    ];
    const { rerender } = render(
      <AtalhosDoNegocio atalhos={boleto} lead={NEGOCIO} contactId="contato-1" />,
    );
    expect(screen.getByRole("link", { name: /Segunda via/ })).toHaveAttribute(
      "href",
      "https://fin.exemplo.com/?doc=123.456.789-09",
    );

    comContato({});
    rerender(<AtalhosDoNegocio atalhos={boleto} lead={NEGOCIO} contactId="contato-1" />);
    expect(screen.queryByRole("link", { name: /Segunda via/ })).toBeNull();
  });
});
