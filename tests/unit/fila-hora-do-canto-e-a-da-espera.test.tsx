import { render, screen } from "@testing-library/react";
import { format, subDays } from "date-fns";
import { describe, expect, it } from "vitest";

import { ConversationListItem } from "@/components/inbox/ConversationListItem";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";

/**
 * A HORA NO CANTO DA LINHA RESPONDE À MESMA PERGUNTA QUE ORDENA A LISTA.
 *
 * Na Fila a lista sai por tempo de espera (`last_inbound_at` crescente), mas a
 * hora do canto era a da última mensagem de QUALQUER lado: bastava o atendente
 * responder para aquela linha mostrar "agora" sem sair do lugar. Os números
 * ficavam fora de ordem de cima para baixo — que é como uma lista certa se lê
 * como aleatória (#464).
 *
 * As três datas do caso ficam a ≥7 dias, no ramo `dd/MM` do formatador: `format`
 * puro, sem arredondamento e sem idioma, então o caso mede QUAL data alimenta o
 * relógio, não como o texto sai. Por isso não há locale nem provider aqui.
 */

const agora = new Date();
/** Espera medida — é ela que a Fila usa para ordenar e para numerar. */
const espera = subDays(agora, 9).toISOString();
/** Última mensagem de qualquer lado — o que a linha mostrava. */
const atividade = subDays(agora, 12).toISOString();
/** Criação da conversa — o fallback, e o relógio mais antigo dos três. */
const criacao = subDays(agora, 300).toISOString();

const horaDaEspera = format(new Date(espera), "dd/MM");
const horaDaAtividade = format(new Date(atividade), "dd/MM");
const horaDaCriacao = format(new Date(criacao), "dd/MM");

const base = {
  id: "c1",
  organization_id: "org",
  contact_id: "ct1",
  channel_session_id: "s1",
  channel: "whatsapp",
  status: "open",
  last_message_at: atividade,
  last_inbound_at: espera,
  last_message_preview: "olá",
  unread_count_for_assignee: 0,
  created_at: criacao,
  contacts: { id: "ct1", display_name: "Cliente", name: null, phone_number: "+595999", tags: [], is_blocked: false, is_anonymized: false },
} as unknown as ConversationWithContact;

/** `queuePosition` dado = a linha está na Fila (é o mesmo sinal que o badge usa). */
const pintar = (conv: ConversationWithContact, queuePosition?: number) =>
  render(
    <ConversationListItem
      conversation={conv}
      isSelected={false}
      onSelect={() => {}}
      queuePosition={queuePosition}
      mostrarCanal={false}
    />,
  );

const cantoDaFila = () => screen.getByTitle("Última mensagem do cliente");

describe("na Fila, o relógio da linha é o relógio da ordem", () => {
  it("⭐ a hora do canto é a da última mensagem do CLIENTE", () => {
    pintar(base, 3);
    expect(cantoDaFila()).toHaveTextContent(horaDaEspera);
  });

  it("⭐ não é a última mensagem de qualquer lado, nem a criação", () => {
    // É a troca que a issue descreve: a linha respondida pelo atendente subia
    // para "agora" enquanto continuava na 7ª posição da fila.
    pintar(base, 3);
    expect(screen.queryByText(horaDaAtividade)).not.toBeInTheDocument();
    expect(screen.queryByText(horaDaCriacao)).not.toBeInTheDocument();
  });

  it("⭐ sem mensagem do cliente, cai no MESMO fallback da pílula de espera", () => {
    // A pílula "Aguardando há…" usa `last_inbound_at ?? created_at`. Duas respostas
    // para o mesmo "desde quando?", a 40px de distância, seriam a próxima
    // divergência — então o fallback é o mesmo, e este caso o prende.
    pintar({ ...base, last_inbound_at: null } as unknown as ConversationWithContact, 1);
    expect(cantoDaFila()).toHaveTextContent(horaDaCriacao);
  });

  it("o rótulo diz o que o número é — o mesmo canto significa outra coisa na Fila", () => {
    pintar(base, 3);
    expect(cantoDaFila()).toBeInTheDocument();
  });
});

describe("fora da Fila, nada muda", () => {
  it("CONTROLE: sem posição na fila, a hora segue sendo a da atividade recente", () => {
    // Sem este caso, "o relógio sempre mostra `last_inbound_at`" passaria no teste
    // de cima — e a aba Todas, que ordena por atividade recente, ficaria com a
    // coluna de horas fora de ordem de novo, só no sentido oposto.
    pintar(base);
    expect(screen.getByText(horaDaAtividade)).toBeInTheDocument();
    expect(screen.queryByText(horaDaEspera)).not.toBeInTheDocument();
  });

  it("o rótulo só aparece onde a leitura muda", () => {
    pintar(base);
    expect(screen.queryByTitle("Última mensagem do cliente")).not.toBeInTheDocument();
  });
});
