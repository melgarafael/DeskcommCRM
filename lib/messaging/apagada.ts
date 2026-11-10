/**
 * A régua de QUEM vê o CONTEÚDO de uma mensagem apagada ("apagar para todos")
 * na bolha da Inbox, e o marcador que diz quem apagou.
 *
 * A linha nunca sai do fio e o corpo nunca é limpo: quem some com a linha deixa
 * a resposta seguinte respondendo ao nada e apaga o histórico de quem atendeu
 * (`handleMessageRevoked` do ingest, que só carimba `revoked_at`).
 *
 * • apagada pelo CONTATO — o texto NÃO aparece: mostrá-lo seria expor
 *   justamente o que o cliente pediu para tirar do ar.
 * • apagada pelo ATENDENTE (mensagem nossa) — o texto continua visível à
 *   equipe, marcado "Visível só aqui no CRM": o gerente segue vendo o que o
 *   atendente mandou e apagou.
 *
 * A inversão dessas pontas foi proposta no #3279, e o mantenedor escolheu
 * manter a regra. A busca da thread, a citação e o PDF da conversa seguem com
 * as regras próprias, que escondem o texto apagado.
 *
 * AUDITORIA: registra o EVENTO (quem apagou, qual mensagem, quando) e **nunca
 * copia o corpo**. `api_audit_log` é append-only, com retenção de 5 anos, e
 * sobrevive ao apagamento da organização — copiar o texto para lá criaria dado
 * pessoal fora do alcance da cascata de anonimização.
 */
export type DirecaoDaMensagem = "inbound" | "outbound";

/**
 * O texto de uma mensagem apagada aparece na bolha da Inbox?
 *
 * `true` só para a apagada pelo atendente; a apagada pelo contato mostra só o
 * marcador.
 */
export function textoDaApagadaApareceNaInbox(direction: DirecaoDaMensagem): boolean {
  return direction === "outbound";
}

/** O marcador da bolha, pela mesma direção — a frase diz QUEM apagou. */
export function marcadorDaApagada(direction: DirecaoDaMensagem): string {
  return direction === "inbound"
    ? "Esta mensagem foi apagada pelo contato"
    : "Esta mensagem foi apagada pelo atendente";
}
