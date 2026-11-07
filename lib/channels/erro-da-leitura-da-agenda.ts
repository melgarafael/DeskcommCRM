/**
 * O ERRO DA LEITURA DA AGENDA DO APARELHO — carrega o STATUS HTTP (#4102).
 *
 * ─── Por que uma CLASSE, e não o texto do erro ──────────────────────────────
 *
 * Quem escolhe a frase da tela (`lib/contacts/recusa-da-agenda.ts`) precisa
 * saber se o transporte recusou com **400** ou com outro status, e o texto da
 * mensagem carrega o código cru do transporte (`<transporte>_contacts_all_<status>`,
 * composto em `lib/waha/client.ts`) — que a doutrina de restrição de canal
 * proíbe de nomear fora da fronteira do canal. O status vem no CAMPO; o texto
 * continua com o código cru, porque é ele que vai para o log, e quem compõe a
 * mensagem é o transporte, o único lugar onde o nome do provider pode morar.
 *
 * `instanceof` e não o formato da mensagem: mensagem de erro de transporte muda
 * entre builds e entre versões do engine — foi assim que a #4102 nasceu (um
 * comentário supunha lista vazia onde o transporte devolvia 400). O que a tela
 * decide não pode depender do texto de um terceiro.
 */
export class ErroDaLeituraDaAgenda extends Error {
  constructor(
    /** O status HTTP que o transporte devolveu — `400` é o caso com conserto na tela. */
    readonly status: number,
    mensagem: string,
  ) {
    super(mensagem);
    this.name = "ErroDaLeituraDaAgenda";
  }
}
