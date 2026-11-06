/**
 * A CAIXA DE MENSAGEM BLOQUEADA ATÉ ALGUÉM ASSUMIR (#3012).
 *
 * Em operação com vários atendentes, responder sem assumir formalmente deixa a
 * conversa sem responsável e a equipe sem saber quem atende o quê. Com a opção
 * ligada, o compositor do Inbox fica travado até o clique em "Assumir".
 *
 * A regra é uma só, e é por isso que ela cabe numa linha: a caixa abre para
 * quem é o DONO ATUAL da conversa, ou foi convidado para atender junto (#2542).
 * Participar permite responder sem substituir o responsável. Isso resolve os dois pedidos da issue de uma
 * vez — sem dono (`null`) ninguém digita, e já assumida por outra pessoa só o
 * dono digita. "Liberar" devolve a conversa à fila (dono `null`) e a caixa
 * trava de novo; "Transferir" entrega a outro e a trava passa a ele.
 *
 * O que esta função NÃO é: autorização. Ela devolve um booleano de TELA. Quem
 * decide o que cada pessoa alcança continua sendo papel, RLS e permissões, e a
 * trava é reversível pelo próprio botão "Assumir" — que nunca é escondido.
 */
export function composerBloqueadoAteAssumir(entrada: {
  /** A opção da ORGANIZAÇÃO está ligada? Ausente/`false` = desligada. */
  ligada: boolean | undefined;
  /** `conversations.assigned_to_user_id` — `null` é fila, sem dono. */
  donoDaConversa: string | null;
  /** Quem está na tela (`user.id`). */
  atendenteId: string | null;
  /** Vínculo ativo lido da rota de participantes, nunca inferido de poder ler. */
  participanteAtivo?: boolean;
}): boolean {
  if (!entrada.ligada) return false;
  // Sem identificação não há como dizer "você é o dono" — e travar quem nem
  // sabe quem é seria pior que liberar. O caminho de sessão sem `user.id` não
  // desenha o Inbox, mas a guarda fica: falha para o lado de sempre.
  if (!entrada.atendenteId) return false;
  if (entrada.participanteAtivo) return false;
  return entrada.donoDaConversa !== entrada.atendenteId;
}
