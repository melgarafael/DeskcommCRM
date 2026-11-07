/**
 * A marca "mencionado" da lista de conversas (#2372).
 *
 * O sino e o push já avisam quem foi citado numa nota interna; o que faltava era
 * a lista de conversas dizer ONDE está o recado. Esta é a régua da marca: some
 * ao abrir a conversa, não duplica, e a identidade do snapshot só muda quando a
 * marca muda (é o que o `useSyncExternalStore` da tela usa para não re-renderizar
 * a lista inteira a cada tecla).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  conversasComMencao,
  desmarcarConversaMencionada,
  inscreverNaListaDeMencoes,
  limparMencoesDaLista,
  marcarConversaMencionada,
} from "./mencao-na-lista";

beforeEach(() => {
  limparMencoesDaLista();
});

describe("marca de menção na lista de conversas", () => {
  it("a conversa da nota mencionada fica marcada", () => {
    marcarConversaMencionada("conv-1");
    expect(conversasComMencao().has("conv-1")).toBe(true);
    expect(conversasComMencao().has("conv-2")).toBe(false);
  });

  it("marcar duas vezes não duplica nem troca o snapshot", () => {
    marcarConversaMencionada("conv-1");
    const antes = conversasComMencao();
    marcarConversaMencionada("conv-1");
    expect(conversasComMencao()).toBe(antes);
    expect([...conversasComMencao()]).toEqual(["conv-1"]);
  });

  it("abrir a conversa desmarca só ela", () => {
    marcarConversaMencionada("conv-1");
    marcarConversaMencionada("conv-2");
    desmarcarConversaMencionada("conv-1");
    expect(conversasComMencao().has("conv-1")).toBe(false);
    expect(conversasComMencao().has("conv-2")).toBe(true);
  });

  it("desmarcar o que não estava marcado não avisa ninguém", () => {
    const ouvinte = vi.fn();
    inscreverNaListaDeMencoes(ouvinte);
    desmarcarConversaMencionada("conv-1");
    expect(ouvinte).not.toHaveBeenCalled();
  });

  it("quem está na tela é avisado a cada mudança, e o cancelamento corta o aviso", () => {
    const ouvinte = vi.fn();
    const cancelar = inscreverNaListaDeMencoes(ouvinte);
    marcarConversaMencionada("conv-1");
    desmarcarConversaMencionada("conv-1");
    expect(ouvinte).toHaveBeenCalledTimes(2);
    cancelar();
    marcarConversaMencionada("conv-2");
    expect(ouvinte).toHaveBeenCalledTimes(2);
  });

  it("limpar devolve a lista vazia (troca de organização/pessoa)", () => {
    marcarConversaMencionada("conv-1");
    limparMencoesDaLista();
    expect([...conversasComMencao()]).toEqual([]);
  });
});
