/** Só traduz o vocabulário do validador, nunca texto digitado no e-mail. */
export function traduzirProblemaDoPasso(problema: string, t: (texto: string) => string): string {
  switch (problema) {
    case "Retire as variáveis indisponíveis antes de ativar.": return t("Retire as variáveis indisponíveis antes de ativar.");
    case "Informe o assunto do e-mail.": return t("Informe o assunto do e-mail.");
    case "Escreva o corpo do e-mail.": return t("Escreva o corpo do e-mail.");
    case "A espera precisa ser de pelo menos 1 dia útil.": return t("A espera precisa ser de pelo menos 1 dia útil.");
    case "Escreva a mensagem do WhatsApp.": return t("Escreva a mensagem do WhatsApp.");
    case "Dê um título à tarefa.": return t("Dê um título à tarefa.");
    case "O ramo precisa de pelo menos um passo em um dos lados.": return t("O ramo precisa de pelo menos um passo em um dos lados.");
    default: return problema;
  }
}
