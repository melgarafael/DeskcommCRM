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
 * ═══ Campanha antiga e chave ausente = LIGADO ═══
 *
 * Campanhas criadas antes destes interruptores não têm as chaves; elas continuam
 * se comportando como antes (preparo automático ligado). Só `false` explícito
 * desliga. E a prévia depende da avaliação: sem avaliar o site não há veredito
 * em que ancorá-la.
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
  return { avaliarSite, gerarPrevia: avaliarSite && s.gerar_previa !== false };
}
