// app/app/settings/tenant/pipelines/_atalhos-do-card.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { EditorDeAtalhos } from "./_atalhos-do-card";

/**
 * A FORMA DA DISCAGEM NO CADASTRO (#3487, 2ª fatia).
 *
 * O domínio (`lib/leads/atalhos-do-card.test.ts`) prova que `sem_pais` monta o
 * `tel:` certo. Aqui a pergunta é a que só a tela responde: **a pessoa consegue
 * escolher?** — e, do outro lado, se a escolha aparece onde ela não faz sentido.
 *
 * O Radix Select espelha as opções num `<select>` nativo oculto e é o valor
 * VISÍVEL do combobox que interessa, como em `profile/_form.test.tsx`.
 */
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));

describe("EditorDeAtalhos — a forma da discagem", () => {
  it("atalho `tel:` oferece a escolha, com `completo` como padrão", () => {
    render(
      <EditorDeAtalhos
        valor={[{ rotulo: "Ligar", icone: "telefone", url: "tel:{{telefone}}" }]}
        onChange={() => {}}
      />,
    );
    const discagem = screen.getByRole("combobox", { name: /Discagem do atalho 1/ });
    expect(discagem).toHaveTextContent("Com o código do país");
  });

  it("atalho `tel:` já escolhido mostra a forma gravada", () => {
    render(
      <EditorDeAtalhos
        valor={[
          { rotulo: "Ligar", icone: "telefone", url: "tel:{{telefone}}", discagem: "sem_pais" },
        ]}
        onChange={() => {}}
      />,
    );
    expect(screen.getByRole("combobox", { name: /Discagem do atalho 1/ })).toHaveTextContent(
      "Sem o código do país (DDD + número)",
    );
  });

  it("atalho `https://` não mostra a escolha — ali o telefone é dado, não alvo de discagem", () => {
    render(
      <EditorDeAtalhos
        valor={[
          { rotulo: "Tirar pedido", icone: "carrinho", url: "https://p.exemplo.com/?c={{telefone}}" },
        ]}
        onChange={() => {}}
      />,
    );
    expect(screen.queryByRole("combobox", { name: /Discagem do atalho/ })).toBeNull();
  });
});
