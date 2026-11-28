// components/kanban/AtalhosDoCard-indisponivel.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AtalhosDoNegocio } from "./AtalhosDoCard";

/**
 * O ATALHO QUE NÃO ABRE DIZ POR QUÊ (issue #3487).
 *
 * ─── O que só este arquivo prova ────────────────────────────────────────────
 *
 * `lib/leads/atalhos-do-card.test.ts` prova a régua (`itensDoAtalho` devolve o
 * motivo). Aqui a pergunta é a que o operador faz: **o botão está na tela, e
 * está escrito o que falta?** A issue pede as duas coisas — "variável sem valor
 * deixa o botão desabilitado, com a dica 'falta o campo X'" —, e é fácil
 * satisfazer uma e esquecer a outra: um `disabled` sem texto é o mesmo silêncio
 * de antes, com um botão cinza a mais.
 *
 * ─── O que NÃO pode aparecer em nenhum caso ─────────────────────────────────
 *
 * `<a href>`. Botão desabilitado é botão; link desabilitado não existe no HTML
 * (`<a>` sem href ainda é focável e semântico). Quem garante que o errado não
 * vira link é `atalhosParaExibir`/`montarHref`; aqui se mede o DOM.
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

const PEDIDO = {
  rotulo: "Tirar pedido",
  icone: "carrinho" as const,
  url: "https://pedidos.exemplo.com/?cliente={{erp_id}}",
};

describe("AtalhosDoNegocio — o atalho que existe mas não abre", () => {
  it("marcador vazio desabilita o botão e diz o campo que falta", () => {
    comContato({});
    const { container } = render(
      // O negócio NÃO tem `erp_id`: é o caso do cliente cadastrado pela metade.
      <AtalhosDoNegocio
        atalhos={[PEDIDO]}
        lead={{ id: "lead-1", custom_fields: {} }}
        contactId="contato-1"
      />,
    );

    // Nada de link quebrado, nada de `?cliente=` vazio.
    expect(container.querySelector("a")).toBeNull();

    const botao = screen.getByRole("button", { name: /Tirar pedido/ });
    expect(botao).toBeDisabled();
    // O motivo é TEXTO na tela, não só `title` (que ninguém vê no celular).
    expect(botao).toHaveTextContent("Falta o campo erp_id");
    expect(botao).toHaveAttribute("title", "Falta o campo erp_id");
    // A faixa continua existindo: o atalho FOI configurado, o dado é que falta.
    expect(screen.getByTestId("atalhos-do-negocio")).toBeInTheDocument();
  });

  it("endereço recusado vira botão explicado — o conserto não é preencher campo", () => {
    comContato({});
    render(
      <AtalhosDoNegocio
        atalhos={[{ rotulo: "Armadilha", icone: "link", url: "javascript:alert(1)" }]}
        lead={{ id: "lead-1", custom_fields: { erp_id: "ERP-1" } }}
        contactId="contato-1"
      />,
    );

    const botao = screen.getByRole("button", { name: /Armadilha/ });
    expect(botao).toBeDisabled();
    expect(botao).toHaveTextContent("O endereço deste atalho não é aceito.");
    // O motivo NÃO acusa campo nenhum: não há dado que conserte `javascript:`.
    expect(botao).not.toHaveTextContent("Falta o campo");
  });

  it("o atalho que resolve continua link, ao lado do que não resolve", () => {
    comContato({});
    const { container } = render(
      <AtalhosDoNegocio
        atalhos={[
          { rotulo: "Ligar", icone: "telefone", url: "tel:{{telefone}}" },
          PEDIDO,
        ]}
        lead={{ id: "lead-1", custom_fields: {} }}
        contactId="contato-1"
      />,
    );

    // Um abre, um explica: a lista não é toda-ou-nada.
    const ligar = screen.getByRole("link", { name: /Ligar/ });
    expect(ligar).toHaveAttribute("href", "tel:+5511999999999");
    expect(screen.getByRole("button", { name: /Tirar pedido/ })).toBeDisabled();
    expect(container.querySelectorAll("a")).toHaveLength(1);
  });

  it("`tel:` sem número suficiente desabilita em vez de discar um dígito", () => {
    contato.atual = {
      id: "contato-1",
      name: "Maria Silva",
      display_name: null,
      phone_number: "1234",
      email: null,
      custom_fields: {},
    };
    render(
      <AtalhosDoNegocio
        atalhos={[{ rotulo: "Ligar", icone: "telefone", url: "tel:{{telefone}}" }]}
        lead={{ id: "lead-1", custom_fields: {} }}
        contactId="contato-1"
      />,
    );

    const botao = screen.getByRole("button", { name: /Ligar/ });
    expect(botao).toBeDisabled();
    expect(botao).toHaveTextContent("Falta o campo telefone");
  });
});
