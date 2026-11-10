import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { navegarNoInbox, soltarFocoEscondido } from "@/components/inbox/InboxLayout";

/**
 * VOLTAR DA CONVERSA DESFAZ O PASSO, EM VEZ DE EMPILHAR (F2 da ADR-0006).
 *
 * O botão "‹ Conversas" fazia `pushState` da lista: a pilha crescia a cada ida
 * e volta, e o gesto de voltar do sistema REABRIA a conversa que a pessoa
 * acabou de fechar. Agora a entrada empilhada pelo Inbox leva a profundidade,
 * e voltar anda essa profundidade para trás. Sem marca (deep-link, clique no
 * aviso, recarga) voltar troca a entrada no lugar: a pilha não cresce.
 *
 * O jsdom não tem o patch do Next que copia o estado interno dele para dentro
 * do objeto do `pushState`; a integração com o roteador é provada no e2e
 * `atender-pelo-celular`.
 */

beforeEach(() => {
  window.history.replaceState(null, "", "/app/inbox");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("navegarNoInbox", () => {
  it("lista → abrir → voltar anda UMA entrada para trás e não acrescenta nenhuma", () => {
    const go = vi.spyOn(window.history, "go").mockImplementation(() => {});
    const antes = window.history.length;

    expect(navegarNoInbox("/app/inbox?id=a", null, "a")).toBe("trocou");
    expect(window.history.length).toBe(antes + 1);

    expect(navegarNoInbox("/app/inbox", "a", null)).toBe("pelo-historico");
    expect(go).toHaveBeenCalledWith(-1);
    expect(window.history.length, "voltar não pode empilhar").toBe(antes + 1);
  });

  it("lista → A → B → voltar cai na LISTA, não em A", () => {
    const go = vi.spyOn(window.history, "go").mockImplementation(() => {});
    navegarNoInbox("/app/inbox?id=a", null, "a");
    navegarNoInbox("/app/inbox?id=b", "a", "b");
    navegarNoInbox("/app/inbox", "b", null);
    expect(go).toHaveBeenCalledWith(-2);
  });

  it("deep-link (sem marca) → voltar troca a entrada no lugar e a pilha não cresce", () => {
    window.history.replaceState(null, "", "/app/inbox?id=x");
    const go = vi.spyOn(window.history, "go");
    const troca = vi.spyOn(window.history, "replaceState");
    const antes = window.history.length;

    expect(navegarNoInbox("/app/inbox", "x", null)).toBe("trocou");
    expect(go).not.toHaveBeenCalled();
    expect(troca).toHaveBeenCalledWith(null, "", "/app/inbox");
    expect(window.location.search).toBe("");
    expect(window.history.length).toBe(antes);
  });

  it("conversa → conversa sem marca troca a entrada no lugar, sem inventar profundidade", () => {
    window.history.replaceState(null, "", "/app/inbox?id=x");
    const antes = window.history.length;
    expect(navegarNoInbox("/app/inbox?id=y", "x", "y")).toBe("trocou");
    expect(window.history.state).toBeNull();
    expect(window.location.search).toBe("?id=y");
    expect(window.history.length).toBe(antes);
  });

  it("link direto X → troca para Y → voltar: nenhuma entrada de X fica para o voltar do sistema reabrir", () => {
    // O clique no aviso abre X; "Transferir para outro número" abre Y; o
    // "‹ Conversas" troca no lugar. Se a troca X → Y empilhasse, a pilha
    // ficaria [X, lista] e o voltar do sistema reabriria X.
    window.history.replaceState(null, "", "/app/inbox?id=x");
    const antes = window.history.length;
    navegarNoInbox("/app/inbox?id=y", "x", "y");
    navegarNoInbox("/app/inbox", "y", null);
    expect(window.history.length).toBe(antes);
    expect(window.location.search).toBe("");
  });
});

/**
 * A LISTA ESCONDIDA NÃO GUARDA O FOCO (F2 da ADR-0006).
 *
 * No celular a lista fica `invisible` atrás da conversa, em vez de sair de
 * cena. No Safari do iPhone tocar num botão não tira o foco do campo: quem
 * digitou em "Buscar conversas" e tocou no resultado seguiria com o teclado
 * aberto, filtrando uma lista que ninguém vê. No computador a lista continua
 * visível e o foco fica onde a pessoa o deixou.
 */
describe("soltarFocoEscondido", () => {
  function montarLista(visibilidade: string) {
    const lista = document.createElement("div");
    lista.style.visibility = visibilidade;
    const busca = document.createElement("input");
    lista.appendChild(busca);
    document.body.appendChild(lista);
    busca.focus();
    return { lista, busca };
  }

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("lista escondida (celular): o campo dentro dela perde o foco", () => {
    const { lista, busca } = montarLista("hidden");
    expect(document.activeElement).toBe(busca);
    soltarFocoEscondido(lista);
    expect(document.activeElement).not.toBe(busca);
  });

  it("lista visível (computador): o foco fica onde estava", () => {
    const { lista, busca } = montarLista("visible");
    soltarFocoEscondido(lista);
    expect(document.activeElement).toBe(busca);
  });

  it("foco fora da lista não é tocado", () => {
    const { lista } = montarLista("hidden");
    const fora = document.createElement("textarea");
    document.body.appendChild(fora);
    fora.focus();
    soltarFocoEscondido(lista);
    expect(document.activeElement).toBe(fora);
  });
});
