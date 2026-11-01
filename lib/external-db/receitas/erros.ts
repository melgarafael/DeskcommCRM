/**
 * ERROS DAS RECEITAS — o que a receita recusa e por quê.
 *
 * A receita genérica do WordPress (`wordpress-conteudo`) tem um filtro por
 * INSTANCE: o conjunto de dados filtráveis depende do que o administrador
 * mapeou na tela. O agente pode pedir um filtro que a instância não tem (a
 * chave não existe) ou que ela tem mas não filtra (o dado está mapeado, mas
 * sem filtro). Nesses casos a resposta é um ERRO LEGÍVEL — nunca um silêncio:
 * devolver a lista inteira como se o filtro tivesse sido aplicado entrega ao
 * cliente o que ele pediu para NÃO ver.
 *
 * A classe existe para a rota e a ferramenta do agente distinguirem este erro
 * dos outros (falha de leitura, fonte não liberada) sem acoplar o módulo
 * inteiro: o `name` é o que identifica o erro no `catch`.
 */

/**
 * O agente pediu um filtro que a instância não consegue aplicar.
 *
 * `chave` é a chave pedida; `mensagem` é a frase pronta, em português, que
 * explica o que houve e o que a instância aceita. A frase é montada pela
 * receita (que conhece o mapeamento) e não pelo chamador — assim o agente
 * recebe a lista de filtros que DEVERIA ter usado.
 */
export class ErroDeFiltroDesconhecido extends Error {
  /** A chave que o agente pediu e que a instância não filtra. */
  readonly chave: string;

  constructor(chave: string, mensagem: string) {
    super(mensagem);
    this.name = "ErroDeFiltroDesconhecido";
    this.chave = chave;
  }
}
