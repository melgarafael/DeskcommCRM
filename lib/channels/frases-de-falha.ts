/**
 * O QUE DIZER À PESSOA quando o canal recusou a mensagem.
 *
 * Mora em `lib/channels/` pelo mesmo motivo que `adapter.codes` mora: as
 * chaves CARREGAM NOME DE PROVIDER (`waha_error`, `meta_not_configured`), e a
 * doutrina de restrição de canal (`docs/doctrine/restricao-de-canal.md`,
 * invariante 1) proíbe esse nome fora daqui — `scripts/lint-channels.ts`
 * reprova, e reprovou este arquivo quando o mapa nasceu dentro de
 * `lib/automation/`.
 *
 * A regra não é burocracia: quem chama não pode ramificar por provider, senão o
 * quarto canal exige editar N lugares espalhados. Aqui a tradução é uma função
 * pura que aceita o código VINDO do adapter e devolve texto de tela — quem
 * chama nunca precisa saber de quem é o código.
 *
 * Texto de TELA, não de log: quem lê é o dono do negócio na aba Atividade, e a
 * frase tem que dizer o que ele faz a respeito. "waha_error" não diz.
 */

/**
 * Exportada para a bolha da conversa poder escrever `t(FRASES_DE_FALHA[codigo])`:
 * é a forma que a cerca de i18n sabe resolver, e ela cobra o espanhol de cada frase.
 */
export const FRASES_DE_FALHA: Record<string, string> = {
  // Sessão do canal fora de WORKING — o número está desconectado.
  channel_session_not_working:
    "O número escolhido não está conectado no momento. Reconecte em Conexões — a mensagem sai sozinha quando ele voltar.",
  // Credencial do transporte ausente no ambiente da instalação.
  waha_not_configured: "A conexão de WhatsApp ainda não foi configurada nesta instalação.",
  meta_not_configured: "A conexão de WhatsApp ainda não foi configurada nesta instalação.",
  zernio_not_configured: "A conexão de WhatsApp ainda não foi configurada nesta instalação.",
  // Canal excluído da Central de Conexões (migration 0106).
  channel_archived:
    "Esse número foi excluído da Central de Conexões. Escolha outro número nesta automação.",
  missing_phone_number: "O contato não tem telefone para receber a mensagem.",
  // O transporte não respondeu, ou respondeu erro.
  waha_error: "Não conseguimos falar com o serviço de WhatsApp. Confira se ele está no ar.",
  meta_error: "O WhatsApp Oficial recusou o envio. Confira a conexão em Conexões.",
  zernio_error: "O canal recusou o envio. Confira a conexão em Conexões.",
  // Falha do NOSSO Storage ao preparar a mídia — não é do canal.
  storage_sign_failed: "Não conseguimos preparar o arquivo para envio.",
  // O watchdog desistiu de uma linha parada em `sending`: o canal pode ter
  // aceitado sem confirmar, então a frase não promete que não saiu.
  send_timeout: "O WhatsApp não confirmou o envio a tempo. Pode ser que a mensagem tenha chegado.",
  // Canal desativado pelo operador (o envio é recusado antes de sair).
  channel_disabled: "Este número está desativado. Reative em Conexões para enviar.",
  // Recusas assíncronas da plataforma oficial, gravadas pelo código numérico.
  "131026": "Este número não tem WhatsApp.",
  "131047": "A janela de 24 horas fechou. Envie um modelo aprovado ou aguarde o cliente escrever.",
};

/**
 * `null` quando o código não tem tradução — e o `null` é deliberado: quem
 * chama decide o texto de reserva, e uma frase genérica inventada aqui
 * ("houve um erro") apagaria a mensagem original do provedor, que às vezes é a
 * única pista real.
 */
export function fraseDaFalhaDeCanal(codigo: string | null | undefined): string | null {
  if (!codigo) return null;
  return Object.hasOwn(FRASES_DE_FALHA, codigo) ? FRASES_DE_FALHA[codigo]! : null;
}
