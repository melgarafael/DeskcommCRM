/**
 * O erro que a rodada grava em `importacoes_de_historico.erro` é técnico
 * (`messages_consulta: …`, `waha_mensagens_invalido`) e pode citar o transporte
 * do canal pelo nome. A tela da conexão mostra uma linha curta dele, com o nome
 * trocado por "canal". Função pura: a tela é cliente e importa só isto.
 */
const LIMITE = 140;

export function resumirErroDaImportacao(erro: string): string {
  const limpo = erro.replace(/waha/gi, "canal").replace(/\s+/g, " ").trim();
  return limpo.length > LIMITE ? `${limpo.slice(0, LIMITE)}…` : limpo;
}
