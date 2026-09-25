/**
 * O RODÍZIO — por qual número esta pessoa vai ser falada.
 *
 * ═══ A regra, em ordem ═══
 *
 * 1. O número em que ela JÁ conversa, se ele estiver no pool e puder enviar.
 * 2. Entre os que podem enviar agora, o de MAIOR FOLGA no teto do dia.
 * 3. Empate: o que está parado há mais tempo.
 * 4. Nenhum pode agora: ninguém — a pessoa espera, e isso não é falha.
 *
 * ═══ Por que o histórico vence a folga ═══
 *
 * Quem já falou com a empresa pelo número A e recebe do número B vê um
 * desconhecido, e a conversa nova nasce separada do histórico dela. Distribuir
 * carga é otimização; falar pelo número que a pessoa reconhece é a mensagem
 * chegar. É a mesma regra que a cobrança do Asaas já usa neste produto.
 *
 * ═══ Por que a escolha é no ENVIO, e não na preparação ═══
 *
 * Decisão do dono (2026-09-19). Na preparação, a divisão é um palpite sobre o
 * futuro: se um número cair, ou estourar o teto, a parte dele trava e alguém
 * tem de intervir. No envio, o rodízio se adapta sozinho — quem está livre
 * trabalha. O custo é que só depois de enviar se sabe por onde foi, e por isso
 * o destinatário guarda o número (migration 0377).
 *
 * ═══ O que o rodízio NÃO faz ═══
 *
 * Não aumenta o que cada número aguenta. Cada um tem o próprio teto, a própria
 * janela e o próprio aquecimento, e o motor de pacing continua mandando em cada
 * um separadamente. Três números novos mandando 100 por dia cada é mais
 * arriscado que um número maduro mandando 100 — o rodízio divide o risco e soma
 * capacidade, nunca dribla limite.
 */

export interface NumeroDisponivel {
  sessionId: string;
  /** Quantos envios ainda cabem hoje neste número. `null` = sem teto conhecido. */
  folgaDoDia: number | null;
  /** O motor de pacing deixa enviar AGORA por este número? */
  podeAgora: boolean;
  /** Último envio por este número, de qualquer origem. `null` = nunca. */
  ultimoEnvio: Date | null;
}

export interface EscolhaDoNumero {
  sessionId: string;
  motivo: "historico" | "folga";
}

/**
 * Escolhe o número. `null` = nenhum pode agora (espera, não erro).
 *
 * `numeroDoHistorico` é o número em que o contato já tem conversa — quem chama
 * resolve isso, para esta função continuar pura.
 */
export function escolherNumero(
  pool: readonly NumeroDisponivel[],
  numeroDoHistorico: string | null,
): EscolhaDoNumero | null {
  const disponiveis = pool.filter((n) => n.podeAgora);
  if (disponiveis.length === 0) return null;

  if (numeroDoHistorico) {
    const conhecido = disponiveis.find((n) => n.sessionId === numeroDoHistorico);
    if (conhecido) return { sessionId: conhecido.sessionId, motivo: "historico" };
  }

  // Sem teto conhecido significa "não sei", e não "infinito": tratar como
  // infinito faria o número sem configuração ganhar sempre, concentrando nele
  // exatamente o volume que o rodízio existe para espalhar. Ele entra no fim da
  // fila de preferência, atrás de qualquer número com folga declarada.
  const ordenados = [...disponiveis].sort((a, b) => {
    const fa = a.folgaDoDia ?? -1;
    const fb = b.folgaDoDia ?? -1;
    if (fa !== fb) return fb - fa;
    // Empate na folga: quem está parado há mais tempo. Nunca enviou vence.
    const ta = a.ultimoEnvio?.getTime() ?? 0;
    const tb = b.ultimoEnvio?.getTime() ?? 0;
    if (ta !== tb) return ta - tb;
    // Último critério, estável: a ordem do id. Sem ele, dois números idênticos
    // alternariam conforme o humor do sort, e o teste não teria o que prender.
    return a.sessionId.localeCompare(b.sessionId);
  });

  return { sessionId: ordenados[0]!.sessionId, motivo: "folga" };
}

/** O pool efetivo: o número principal da campanha mais os vinculados, sem repetir. */
export function poolDaCampanha(
  principal: string,
  vinculados: readonly string[],
): string[] {
  return [...new Set([principal, ...vinculados])];
}
