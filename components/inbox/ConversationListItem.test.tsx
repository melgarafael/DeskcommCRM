/**
 * A etiqueta "Grupo" na lista de conversas.
 *
 * `conversations.is_group` já chega no `SELECT_COLS` do handler (schema
 * original) — este teste prende só a LEITURA na tela: quem abre o inbox
 * precisa distinguir uma conversa de grupo de uma individual sem abrir cada
 * uma. Props mínimas copiadas de `ConversationList.tsx`, via
 * `__fixtures__/conversa.ts`.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ConversationListItem } from "./ConversationListItem";
import { conversaDeExemplo } from "./__fixtures__/conversa";

describe("ConversationListItem — etiqueta de grupo", () => {
  it("conversa de grupo tem a etiqueta Grupo", () => {
    render(
      <ConversationListItem
        conversation={{ ...conversaDeExemplo.conversation, is_group: true }}
        {...conversaDeExemplo.props}
      />,
    );
    expect(screen.getByText("Grupo")).toBeInTheDocument();
  });

  it("conversa individual não tem", () => {
    render(
      <ConversationListItem
        conversation={{ ...conversaDeExemplo.conversation, is_group: false }}
        {...conversaDeExemplo.props}
      />,
    );
    expect(screen.queryByText("Grupo")).toBeNull();
  });
});

/**
 * A bolinha no canto do avatar. A cor sai de quem está no comando, mas cor
 * sozinha não se explica — a palavra vem junto, no `title` e no nome acessível.
 */
describe("ConversationListItem — bolinha de quem atende", () => {
  it("a bolinha do avatar diz em palavras quem está no comando", () => {
    render(
      <ConversationListItem
        conversation={{
          ...conversaDeExemplo.conversation,
          assigned_to_user_id: "user-1",
          assigned_to_user_name: "Ana",
          assignee_kind: "user",
        }}
        {...conversaDeExemplo.props}
      />,
    );
    const bolinha = screen.getByRole("img", { name: "Em atendimento" });
    expect(bolinha).toHaveAttribute("title", "Em atendimento");
  });

  it("conversa encerrada: a bolinha diz Encerrada", () => {
    render(
      <ConversationListItem
        conversation={{ ...conversaDeExemplo.conversation, status: "closed" }}
        {...conversaDeExemplo.props}
      />,
    );
    expect(screen.getByRole("img", { name: "Encerrada" })).toHaveAttribute("title", "Encerrada");
  });

  // O caminho comum da aba de fechadas: alguém assumiu e fechou. Fechar não solta
  // o dono (`fn_service_status`), e `comandoDaConversa` segue dizendo `humano` de
  // propósito — mas a PALAVRA "Em atendimento" afirmaria um atendimento que acabou.
  it("conversa encerrada COM dono: a bolinha diz Encerrada, nunca Em atendimento", () => {
    render(
      <ConversationListItem
        conversation={{
          ...conversaDeExemplo.conversation,
          status: "closed",
          assigned_to_user_id: "user-1",
          assigned_to_user_name: "Ana",
          assignee_kind: "user",
        }}
        {...conversaDeExemplo.props}
      />,
    );
    expect(screen.getByRole("img", { name: "Encerrada" })).toHaveAttribute("title", "Encerrada");
    expect(screen.queryByRole("img", { name: "Em atendimento" })).toBeNull();
  });
});

/**
 * A caixa de seleção do lote (#2484, fatia F1).
 *
 * Duas regras medidas aqui: a caixa SÓ existe quando a seleção está ligada —
 * sem a prop de seleção a lista é exatamente a que era —, e marcar NÃO abre a
 * conversa. O dia que os dois gestos virarem um só, ninguém mais consegue
 * marcar três conversas sem abrir as três.
 */
describe("ConversationListItem — seleção em lote", () => {
  it("sem seleção ligada, não existe caixa nenhuma", () => {
    render(
      <ConversationListItem
        conversation={conversaDeExemplo.conversation}
        {...conversaDeExemplo.props}
      />,
    );
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("com seleção ligada, a caixa alterna o id e NÃO abre a conversa", () => {
    const onSelect = vi.fn();
    const alternar = vi.fn();
    render(
      <ConversationListItem
        conversation={conversaDeExemplo.conversation}
        {...conversaDeExemplo.props}
        onSelect={onSelect}
        onAlternarSelecao={alternar}
      />,
    );
    const caixa = screen.getByRole("checkbox");
    expect(caixa).toHaveAttribute("aria-checked", "false");
    fireEvent.click(caixa);
    expect(alternar).toHaveBeenCalledWith(conversaDeExemplo.conversation.id);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("linha marcada: a caixa aparece checada", () => {
    render(
      <ConversationListItem
        conversation={conversaDeExemplo.conversation}
        {...conversaDeExemplo.props}
        selecionado
        onAlternarSelecao={() => {}}
      />,
    );
    expect(screen.getByRole("checkbox")).toHaveAttribute("aria-checked", "true");
  });

  it("linha marcada usa o fundo que acompanha o tema, não o degrau fixo da marca", () => {
    // `bg-accent-50` tem o mesmo hex quase branco nos dois temas: no escuro o nome
    // (texto claro) sumia (prova pela tela do #2909). `bg-accent-soft` muda com o tema.
    render(
      <ConversationListItem
        conversation={conversaDeExemplo.conversation}
        {...conversaDeExemplo.props}
        selecionado
        onAlternarSelecao={() => {}}
      />,
    );
    // A caixa é filha direta do contêiner da linha, que é quem recebe o fundo.
    const linha = screen.getByRole("checkbox").parentElement!;
    expect(linha.className).toContain("bg-accent-soft");
    expect(linha.className).not.toContain("bg-accent-50");
  });
});
