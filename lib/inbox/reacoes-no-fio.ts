import type { Message } from "@/lib/types/messaging";

/** Uma reação desenhada como marca sobre o balão que ela aponta. */
export interface ReacaoNoBalao {
  emoji: string;
  direction: "inbound" | "outbound";
}

/**
 * A REAÇÃO NÃO É BALÃO (#2797/#2815).
 *
 * A linha `type='reaction'` tem corpo nulo e aponta o alvo por
 * `reply_to_message_id`. Desenhada como mensagem, ela virava um segundo balão
 * do cliente que só trazia a CITAÇÃO do alvo e a hora — sem o emoji —, e quem
 * lia entendia que o cliente citou a própria mensagem e não escreveu nada.
 *
 * Aqui ela sai do fio e vira marca no alvo. Uma por autor por alvo (o WhatsApp
 * guarda uma só): se duas linhas do mesmo autor sobreviverem, vale a mais nova.
 * A remoção apaga a linha no banco, e a marca some na próxima leitura do fio.
 * Reação sem emoji ou sem alvo não desenha nada — nunca vira balão.
 */
export function separarReacoes(messages: Message[]): {
  falas: Message[];
  reacoesPorAlvo: Map<string, ReacaoNoBalao[]>;
} {
  const falas: Message[] = [];
  const ultimaPorAutor = new Map<string, { alvo: string; sentAt: number; reacao: ReacaoNoBalao }>();
  for (const m of messages) {
    if (m.type !== "reaction") {
      falas.push(m);
      continue;
    }
    const meta = m.metadata?.reaction as { emoji?: unknown; author?: unknown } | undefined;
    const emoji = typeof meta?.emoji === "string" ? meta.emoji : "";
    const alvo = m.reply_to_message_id;
    if (!emoji || !alvo) continue;
    const autor = typeof meta?.author === "string" ? meta.author : m.direction;
    const chave = `${alvo}\u0000${autor}`;
    const sentAt = new Date(m.sent_at).getTime();
    const anterior = ultimaPorAutor.get(chave);
    if (anterior && anterior.sentAt > sentAt) continue;
    ultimaPorAutor.set(chave, { alvo, sentAt, reacao: { emoji, direction: m.direction } });
  }
  const reacoesPorAlvo = new Map<string, ReacaoNoBalao[]>();
  for (const { alvo, reacao } of ultimaPorAutor.values()) {
    reacoesPorAlvo.set(alvo, [...(reacoesPorAlvo.get(alvo) ?? []), reacao]);
  }
  return { falas, reacoesPorAlvo };
}
