/**
 * OS LIMITES DE RESPOSTA QUE A PRÓPRIA REDE IMPÕE (A21, TikTok).
 *
 * Hetero-restrição, na família da doutrina `docs/doctrine/restricao-de-canal.md`:
 * a plataforma me PROÍBE, e o pedido falha na hora com um erro dela. Aqui a rede
 * é o TikTok, que só deixa a empresa RESPONDER (nunca começar a conversa) e, depois
 * da última mensagem do cliente, aceita no máximo **10 mensagens em 48 horas**.
 * Passou disso, o pedido volta com um erro cru do provedor que ninguém sabe ler.
 *
 * ## O que este arquivo decide, e o que não decide
 *
 * É PURO e síncrono — quem lê o banco é o chamador (a cadeia `before_send` para a
 * IA, `sendMessageHandler` para a equipe). Decide três recusas, sempre com texto
 * que diz a SAÍDA e não só o problema:
 *
 *  - `janela_da_rede_fechada` — passaram mais de 48 h (ou o cliente nunca escreveu);
 *  - `teto_da_rede` — as 10 mensagens da janela já saíram, para qualquer autor;
 *  - `reserva_da_equipe` — a IA só usa 8 das 10. As 2 últimas são de quem atende:
 *    sem isso a IA gasta o limite inteiro e a equipe fica sem como responder o
 *    cliente que acabou de pedir uma visita.
 *
 * A janela de 24 h que o resto do produto aplica às redes sociais
 * (`messaging-window.ts`) NÃO muda aqui: no TikTok ela continua valendo e é mais
 * apertada que a da rede. Alargá-la por rede mexe em uma dúzia de consumidores
 * (composer, selo, lembrete de agenda, follow-up) e fica para uma fatia própria.
 *
 * ## Por que o valor é DECLARADO por rede e não derivado do provedor
 *
 * O provedor das redes sociais serve várias redes, e cada uma mede um limite
 * diferente (o Instagram, por exemplo, tem 24 h e nenhum teto de quantidade).
 * Só entra aqui rede MEDIDA — a mesma regra de `NOTA_DE_VOZ_POR_REDE_SOCIAL` em
 * `../capabilities.ts`. Rede ausente = sem limite próprio, e nada muda para ela.
 */

const HORA_MS = 60 * 60 * 1000;

export interface LimitesDaRede {
  /** Quanto tempo depois da última mensagem do cliente a rede ainda aceita resposta. */
  readonly janelaMs: number;
  /** Quantas mensagens a empresa pode mandar dentro da janela, somados todos os autores. */
  readonly maxRespostas: number;
  /** Quantas dessas ficam só para a equipe: a IA para em `maxRespostas - reservaParaEquipe`. */
  readonly reservaParaEquipe: number;
  /**
   * Quantas fotos do catálogo a IA anexa por turno, SEM legenda (a rede não aceita imagem
   * e texto na mesma mensagem). Não é limite da rede e sim escolha de produto: cada foto
   * gasta uma das mensagens da janela, e três fotos com legenda gastariam seis.
   */
  readonly fotosPorTurnoDaIa: number;
}

/**
 * Medido em 25/11/2026, documentação do provedor de redes sociais (Zernio), página
 * "TikTok › Direct messages": "After the user's last message, TikTok accepts up to
 * 10 messages within 48 hours. A send outside that window fails with TikTok's error."
 */
export const LIMITES_POR_REDE_SOCIAL: Readonly<Record<string, LimitesDaRede>> = {
  tiktok: { janelaMs: 48 * HORA_MS, maxRespostas: 10, reservaParaEquipe: 2, fotosPorTurnoDaIa: 2 },
};

/** Os limites desta rede, ou `null` quando ela não tem limite próprio medido. */
export function limitesDaRede(rede: string | null | undefined): LimitesDaRede | null {
  if (!rede) return null;
  // `hasOwnProperty.call` e não `LIMITES[rede]`: a string vem do banco, e
  // "constructor"/"__proto__" alcançariam o protótipo do objeto.
  if (!Object.prototype.hasOwnProperty.call(LIMITES_POR_REDE_SOCIAL, rede)) return null;
  return LIMITES_POR_REDE_SOCIAL[rede] ?? null;
}

export type AutorDoEnvio = "ia" | "equipe";

export type CodigoDoLimiteDaRede = "janela_da_rede_fechada" | "teto_da_rede" | "reserva_da_equipe";

export type VeredictoDoLimiteDaRede =
  | { permitido: true }
  | {
      permitido: false;
      codigo: CodigoDoLimiteDaRede;
      /** Texto de GENTE (e do modelo): diz o número, a janela e o que fazer. */
      mensagem: string;
    };

export interface EntradaDoLimiteDaRede {
  limites: LimitesDaRede;
  autor: AutorDoEnvio;
  /** Mensagens da empresa que já saíram desde a última do cliente (sem as que falharam). */
  respostasNaJanela: number;
  /** `conversations.last_inbound_at`. `null` = o cliente nunca escreveu. */
  lastInboundAt: Date | null;
  now: Date;
}

/** Desvio de relógio tolerado entre o carimbo do cliente e o `now` do servidor. */
const DESVIO_DE_RELOGIO_MS = 5 * 60 * 1000;

function horas(ms: number): number {
  return Math.round(ms / HORA_MS);
}

/**
 * Pode sair mais UMA mensagem desta conversa agora?
 *
 * Fail-closed no relógio, como `windowRemainingMs`: cliente que nunca escreveu não
 * tem janela. A borda é exclusiva: em 48 h exatas já fechou.
 */
export function decidirLimiteDaRede(entrada: EntradaDoLimiteDaRede): VeredictoDoLimiteDaRede {
  const { limites, autor, respostasNaJanela, lastInboundAt, now } = entrada;
  const janelaHoras = horas(limites.janelaMs);

  // Carimbo no futuro: com `decorrido` negativo a janela fecharia só 48 h depois do carimbo, e
  // ele abriria mais do que a rede permite. Até 5 min de desvio de relógio vale como "acabou de
  // escrever" (`Math.max(0, ...)`); acima disso o carimbo não é confiável e a janela fica fechada.
  const bruto = lastInboundAt === null ? Number.POSITIVE_INFINITY : now.getTime() - lastInboundAt.getTime();
  const decorrido = bruto < -DESVIO_DE_RELOGIO_MS ? Number.POSITIVE_INFINITY : Math.max(0, bruto);
  if (decorrido >= limites.janelaMs) {
    return {
      permitido: false,
      codigo: "janela_da_rede_fechada",
      mensagem:
        `A janela de ${janelaHoras} h do TikTok fechou: a empresa só pode responder depois que o ` +
        "cliente escrever de novo. Aguarde a próxima mensagem dele.",
    };
  }

  if (respostasNaJanela >= limites.maxRespostas) {
    return {
      permitido: false,
      codigo: "teto_da_rede",
      mensagem:
        `Limite do TikTok: ${limites.maxRespostas} respostas em ${janelaHoras} h desde a última ` +
        "mensagem do cliente, e elas já foram usadas. Só depois que o cliente escrever de novo " +
        "dá para responder.",
    };
  }

  const tetoDaIa = limites.maxRespostas - limites.reservaParaEquipe;
  if (autor === "ia" && respostasNaJanela >= tetoDaIa) {
    return {
      permitido: false,
      codigo: "reserva_da_equipe",
      mensagem:
        `A IA já usou ${tetoDaIa} das ${limites.maxRespostas} respostas que o TikTok permite em ` +
        `${janelaHoras} h. As ${limites.reservaParaEquipe} últimas ficam para a equipe. ` +
        "Não reescreva a mensagem: o limite é de quantidade, não de conteúdo. " +
        "Encerre o turno e deixe a conversa para uma pessoa.",
    };
  }

  return { permitido: true };
}
