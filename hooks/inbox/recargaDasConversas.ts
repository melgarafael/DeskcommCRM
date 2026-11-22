import type { QueryClient } from "@tanstack/react-query";

/**
 * A RECARGA QUE O REALTIME PEDE, AGRUPADA — e sem cancelar a busca em voo.
 *
 * Uma única mensagem que chega gera uma RAJADA de eventos (o INSERT em
 * `messages` e várias escritas em `conversations`), e cada evento invalidava
 * `["conversations"]` na hora. `invalidateQueries` cancela a busca em curso
 * (`cancelRefetch` é o padrão), então a rajada virava várias buscas da lista,
 * cada uma cancelando a anterior — no trace do CI, 5 GET em 5ms.
 *
 * O que isto NÃO é: a causa da falha intermitente do e2e
 * `encerramento-atendimento`. O controle aprovado (run 37329560310) tem a
 * MESMA rajada de 5 GET cancelados e passou; o que separou a falha (run
 * 37320609105) foi o servidor respondendo em ~4s pedidos que nunca são
 * cancelados. O ganho aqui é menos carga, não o conserto daquela asserção.
 *
 * Duas regras, e as duas importam:
 *  - a rajada vira UMA busca, que começa depois da janela;
 *  - se já há busca da lista em voo, ESPERA ela terminar e só então recarrega.
 *    Cancelar perde a resposta; não recarregar perde a escrita que chegou
 *    depois de ela começar.
 *
 * Também recarrega `["conversation", id]` — a conversa aberta que NÃO está na
 * aba atual (fechada, de outro filtro) vem só dessa busca, e nenhum evento a
 * alcançava: ela ficava velha até um F5.
 *
 * Por QueryClient, e não por hook: os dois canais do inbox (lista e mensagens)
 * pedem a mesma recarga, e agrupar só um deles deixaria o outro cancelando.
 */
const JANELA_MS = 150;
const agendadas = new WeakMap<QueryClient, ReturnType<typeof setTimeout>>();

export function agendarRecargaDasConversas(qc: QueryClient): void {
  if (agendadas.has(qc)) return;
  agendadas.set(qc, setTimeout(() => descarregar(qc), JANELA_MS));
}

function descarregar(qc: QueryClient): void {
  // ponytail: espera por polling na janela; sem teto — uma busca que nunca
  // termina adia a recarga até ela falhar, que é o que o cancelamento fazia pior.
  if (qc.isFetching({ queryKey: ["conversations"] }) > 0) {
    agendadas.set(qc, setTimeout(() => descarregar(qc), JANELA_MS));
    return;
  }
  agendadas.delete(qc);
  void qc.invalidateQueries({ queryKey: ["conversations"] });
  void qc.invalidateQueries({ queryKey: ["conversation"] });
}
