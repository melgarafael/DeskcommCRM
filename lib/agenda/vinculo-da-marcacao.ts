"use client";

import * as React from "react";

/**
 * QUEM É O CLIENTE DESTA MARCAÇÃO — e de ONDE ele veio.
 *
 * ## O defeito
 *
 * Medido numa instalação real em 2026-09-12: "Novo agendamento" abriu com um
 * contato JÁ selecionado, herdado de uma abertura anterior feita a partir da
 * conversa daquele contato. Quem não reparasse marcaria o compromisso no nome
 * de outra pessoa — e o campo parece preenchido de propósito, então não há o
 * que estranhar na tela.
 *
 * ## Por que "limpar ao fechar" NÃO é o conserto
 *
 * O conserto óbvio — zerar o cliente quando o painel fecha — troca um defeito
 * por outro, e o `e2e` mediu isso: `agenda-google-meet.spec.ts:196` e
 * `agenda-presenca-recuperacao.spec.ts:312` reprovaram com
 * `contact_id: null`. As duas specs fazem o mesmo gesto que uma pessoa faz:
 * abrem "Marcar compromisso" DE DENTRO da conversa, fecham o painel para
 * navegar a grade até a semana certa, e reabrem em "Novo agendamento". Limpar
 * no fechamento apaga ali o contexto que a conversa tinha acabado de dar, e o
 * compromisso nasce sem dono.
 *
 * ## A distinção que resolve os dois: DE ONDE veio, não QUANDO limpar
 *
 * O contexto do Inbox não é estado do painel — ele é da ROTA. O link "Marcar
 * compromisso" leva a `/app/agenda?contato=…&conversa=…`, e enquanto a pessoa
 * está NESSA página o cliente é o contexto dela, não sobra de uma vez anterior.
 * Quando ela vai para a Agenda pelo menu, a rota perde os parâmetros — e é
 * exatamente aí que o cliente tinha de sumir e não sumia, porque o componente
 * continua montado (mesma rota, só a query muda) e o estado sobrevivia.
 *
 * Daí a regra, em uma frase: **o painel sempre abre com o vínculo que a ROTA
 * carrega; o que a pessoa escolhe DENTRO dele vive só enquanto ele está
 * aberto.** Sem contexto na rota, abre vazio — "Compromisso pessoal, sem
 * cliente", que é um estado legítimo. Com contexto na rota, abre com ele,
 * quantas vezes for reaberto.
 *
 * Está aqui, e não em três linhas dentro do componente, pelo mesmo motivo de
 * `ancora-depois-de-marcar.ts`: assim dá para MEDIR nos dois sentidos. Uma
 * cerca que só lesse o texto do `_client.tsx` atrás de um `setContactId("")`
 * ficaria verde justamente com o produto quebrado — foi o que aconteceu.
 */
export type VinculoDaMarcacao = {
  /** `contacts.id`, ou "" para "compromisso pessoal, sem cliente". */
  contact: string;
  /** `conversations.id`, ou "" quando não há conversa vinculada. */
  conversation: string;
};

export const SEM_VINCULO: VinculoDaMarcacao = { contact: "", conversation: "" };

export function useVinculoDaMarcacao() {
  /**
   * O vínculo que a ROTA carrega. Ref, e não estado: mudá-lo não deve
   * redesenhar nem — pior — apagar o que a pessoa está preenchendo com o
   * painel aberto. Ele é consultado nos dois momentos em que o painel volta
   * ao estado neutro (abrir e fechar).
   */
  const daRota = React.useRef<VinculoDaMarcacao>(SEM_VINCULO);
  const [vinculo, setVinculo] = React.useState<VinculoDaMarcacao>(SEM_VINCULO);

  /**
   * A rota disse qual é o contexto da PÁGINA. Chamado a cada mudança de query,
   * inclusive quando ela deixa de trazer contexto — é essa chamada "vazia" que
   * faz o cliente da conversa parar de valer quando a pessoa vai para a Agenda
   * pelo menu.
   *
   * @returns `true` quando a rota trouxe um cliente — o sinal de que a página
   *   foi aberta PARA marcar (o link do Inbox), e o painel deve abrir sozinho.
   */
  const registrarRota = React.useCallback((novo: VinculoDaMarcacao) => {
    daRota.current = novo;
    if (!novo.contact) return false;
    setVinculo(novo);
    return true;
  }, []);

  /**
   * O painel voltou ao estado neutro (abriu pelo botão, ou fechou sem
   * confirmar). O vínculo volta a ser o da rota — que é vazio quando a rota
   * não tem contexto, e é o cliente da conversa quando tem.
   */
  const reiniciar = React.useCallback(() => setVinculo(daRota.current), []);

  /** A pessoa escolheu à mão, dentro do painel. Morre no próximo `reiniciar`. */
  const escolher = React.useCallback((novo: VinculoDaMarcacao) => setVinculo(novo), []);

  return { vinculo, registrarRota, reiniciar, escolher };
}
