/**
 * ENVIAR CONTATO: O FORMULÁRIO MANUAL ACOMPANHA O IDIOMA DA TELA (#4806).
 *
 * O #4767 traduziu a busca e o "Carregando…" do diálogo **Enviar contato**
 * (#4754) e deixou de fora o bloco manual do MESMO diálogo: o rótulo que o
 * abre, o campo de nome e o botão de envio continuavam como literal em
 * português (``: "Ou informe um contato"`, `<Label>Nome (opcional)</Label>`,
 * `Enviar contato`), fora de `t()`. Quem trocava o idioma para espanhol via
 * três textos em português no meio de uma tela traduzida.
 *
 * Por que um teste de RENDER, e não mais um caso na varredura de literais
 * (`i18n-espanhol-cobre-a-tela`): aquela guarda só acusa o literal que tem
 * MARCA ORTOGRÁFICA do português (`ç`, `ã`, `nh`, `não`, `para`…). "Ou informe
 * um contato", "Nome (opcional)" e "Enviar contato" não têm nenhuma — foi assim
 * que passaram pelo gate. A prova de que ESTE conserto vale é o texto que sai
 * na tela em espanhol, com o tradutor de produção (`traduzir`), e é isso que
 * se mede aqui.
 *
 * O que cada caso prende:
 *
 *   (a) ES — com a tela em espanhol, o bloco manual mostra "O indica un
 *       contacto", "Nombre (opcional)" e "Enviar contacto", e nenhum dos três
 *       em português. Fica VERMELHO pelo motivo certo se qualquer um dos três
 *       `t()` sair.
 *   (b) pt-BR — os mesmos três textos em português. Sem este lado, o caso (a)
 *       passaria com o idioma trocado por engano.
 *
 * A lista de contatos é vazia e a busca também: é a condição em que a tela
 * abre o bloco manual (`contacts.length === 0`). O envio não acontece aqui —
 * nenhum clique é dado.
 *
 * Roda com: pnpm exec vitest run tests/unit/enviar-contato-formulario-em-espanhol.test.tsx
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ContactPickerDialog } from "@/components/inbox/composer/ContactPickerDialog";
import { DICIONARIO, traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";

const estado = vi.hoisted(() => ({ idioma: "pt-BR" as string }));

vi.mock("@/hooks/i18n/useT", () => ({
  useT: () => (texto: string) => traduzir(texto, estado.idioma as Idioma),
}));

/**
 * A base sem contato nenhum: é o estado em que o diálogo abre o formulário
 * manual. Nada aqui toca a rede — a lista é o dado que interessa à tela.
 */
vi.mock("@/hooks/contacts/useContactList", () => ({
  useContactList: () => ({
    data: { pages: [{ data: [], meta: { has_more: false } }] },
    isLoading: false,
    isFetchingNextPage: false,
    hasNextPage: false,
    fetchNextPage: vi.fn(),
  }),
}));

beforeEach(() => {
  estado.idioma = "pt-BR";
});
afterEach(cleanup);

function abreOEnviarContato(idioma: Idioma) {
  estado.idioma = idioma;
  render(<ContactPickerDialog open onOpenChange={vi.fn()} onPick={vi.fn()} />);
}

/** Os três textos da issue, na chave em português (que é a chave do dicionário). */
const OS_TRES = ["Ou informe um contato", "Nome (opcional)", "Enviar contato"] as const;

describe("Enviar contato: o formulário manual segue o idioma da tela (#4806)", () => {
  it("em espanhol mostra os três textos traduzidos e nenhum deles em português", () => {
    abreOEnviarContato("es");

    // Os três saem do dicionário de produção — o espanhol medido, não o suposto.
    for (const chave of OS_TRES) {
      expect(DICIONARIO[chave]?.es, `a chave "${chave}" perdeu o espanhol`).toBeTruthy();
    }

    expect(screen.getByText("O indica un contacto")).toBeTruthy();
    expect(screen.getByText("Nombre (opcional)")).toBeTruthy();
    // O título do diálogo também é "Enviar contato", já traduzido antes desta
    // issue: o botão é achado por papel, para não casar com o título.
    expect(screen.getByRole("button", { name: "Enviar contacto" })).toBeTruthy();

    // E o que a issue mediu: nenhum dos três em português no bloco manual.
    for (const chave of OS_TRES) {
      expect(
        screen.queryByText(chave),
        `com a tela em espanhol, "${chave}" continuou saindo em português`,
      ).toBeNull();
    }
  });

  it("em português mostra os mesmos três textos em português", () => {
    abreOEnviarContato("pt-BR");

    expect(screen.getByText("Ou informe um contato")).toBeTruthy();
    expect(screen.getByText("Nome (opcional)")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Enviar contato" })).toBeTruthy();

    for (const chave of OS_TRES) {
      expect(
        screen.queryByText(DICIONARIO[chave]?.es ?? chave),
        `em português apareceu o espanhol de "${chave}": o idioma não foi aplicado`,
      ).toBeNull();
    }
  });
});
