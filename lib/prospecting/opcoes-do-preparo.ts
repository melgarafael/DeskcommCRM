/**
 * Os DOIS INTERRUPTORES do preparo automático, escolhidos na hora da busca
 * (guardados em `prospecting_campaigns.search`, que já é jsonb — sem migration):
 *
 * - `avaliar_site`: o sistema verifica o site de cada empresa sozinho (rede, sem custo de IA);
 * - `gerar_previa`: o sistema escreve a prévia da mensagem sozinho (consome crédito de IA).
 *
 * Quem não quer pagar nem esperar por isso desliga: a avaliação e a prévia seguem
 * disponíveis pelos botões ("Verificar agora" e "Prévia da abordagem"), e o agente
 * escreve a mensagem na hora do envio, conforme a configuração dele.
 *
 * ═══ Chave ausente: a avaliação LIGA, a prévia NÃO ═══
 *
 * Campanhas criadas antes destes interruptores não têm as chaves. Nelas a
 * verificação do site segue automática (só rede, sem custo de IA; só `false`
 * explícito a desliga), mas a prévia escrita pela IA fica DESLIGADA: só `true`
 * explícito a liga. Quem atualiza a instalação não passa a gastar crédito de IA
 * numa campanha antiga sem ter pedido (decisão do dono, doc 163, letra B). A busca
 * nova grava as duas chaves (o interruptor aparece na hora da busca, ligado).
 * E a prévia depende da avaliação: sem avaliar o site não há veredito em que
 * ancorá-la. O espelho em SQL desta régua é `ORGS_COM_PREPARO_PENDENTE` (worker).
 *
 * Função pura e sem import de servidor: a tela e o servidor leem a MESMA régua.
 */
export interface OpcoesDoPreparo {
  avaliarSite: boolean;
  gerarPrevia: boolean;
}

export function opcoesDoPreparo(search: unknown): OpcoesDoPreparo {
  const s = search && typeof search === "object" ? (search as Record<string, unknown>) : {};
  const avaliarSite = s.avaliar_site !== false;
  return { avaliarSite, gerarPrevia: avaliarSite && s.gerar_previa === true };
}
