/**
 * Resposta opcional, definida no prompt do agente, para mensagens que
 * contenham exclusivamente cumprimentos. Pedidos seguem o fluxo normal.
 */
export function respostaParaSaudacao(prompt: string, mensagens: readonly string[]): string | null {
  const resposta = prompt.match(/^RESPOSTA_SAUDACAO:\s*(\S[^\r\n]*)$/m)?.[1]?.trim();
  if (!resposta || mensagens.length === 0) return null;

  const apenasSaudacao = mensagens.every((mensagem) => {
    const texto = mensagem
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[\p{P}\p{S}\s]+/gu, ' ')
      .trim();
    return /^(?:(?:oi|ola|bom dia|boa tarde|boa noite|boa noote|tudo bem|tudo bom|como vai)(?:\s+|$))+$/.test(texto);
  });
  return apenasSaudacao ? resposta : null;
}
