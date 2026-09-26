/** O que dizer a quem está INSTALANDO, por balde de erro. Sem import nenhum de
 * propósito: quem lê a prova de crédito é uma tela `"use client"`, e
 * `prova-de-credito.ts` arrasta o runtime do modelo para o bundle do browser.
 * As frases chegam à tela por `t(variável)`; o espanhol é cobrado no teste. */
export const EXPLICACAO_POR_BALDE = {
  limite_ou_saldo: "A empresa de IA recusou por falta de saldo ou limite de uso. Adicione crédito na conta dela — sem isso ele não responde a nenhum cliente.",
  credencial_recusada: "A empresa de IA não aceitou esta chave. Confira se ela foi colada inteira e se é a chave do provedor escolhido.",
  modelo_inexistente: "A empresa de IA não reconhece o modelo escolhido para ele. Dá para escolher outro em IA › Provedores.",
  provedor_indisponivel: "Não consegui falar com a empresa de IA agora — rede ou serviço fora do ar. Isto não é a chave: tente de novo em minutos.",
} as const;

/** Balde que este módulo não conhece: nunca vazio, nunca o corpo do provedor. */
export const EXPLICACAO_SEM_BALDE = "A empresa de IA recusou a chamada de teste, e não sei dizer o motivo pelo que ela respondeu. Confira o saldo e a chave na conta da empresa de IA.";

export function explicacaoParaQuemInstala(codigo: string): string {
  return (EXPLICACAO_POR_BALDE as Record<string, string>)[codigo] ?? EXPLICACAO_SEM_BALDE;
}
