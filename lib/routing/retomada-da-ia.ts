/**
 * A CONVERSA DEVOLVIDA À IA NÃO VOLTA PARA A DISTRIBUIÇÃO SÓ PORQUE O CLIENTE ESCREVEU.
 *
 * ## O defeito que isto fecha
 *
 * Com distribuição automática (rodízio ou menor carga), TODA mensagem nova do
 * cliente numa conversa sem dono pede distribuição (`trg_routing_nova_mensagem_do_cliente`,
 * migration 9347), e o `routing-worker` entrega a conversa a uma pessoa em menos
 * de um minuto. A entrega grava `assignee_kind = 'user'` e o gate da IA cala o
 * agente (`conversa_de_humano`).
 *
 * Resultado medido numa instalação de teste (D6, 2026-11-20): a pessoa clicou em
 * "Devolver ao automático", o cliente escreveu, a IA respondeu — e 30 segundos
 * depois a distribuição entregou a conversa de novo ao técnico, que nem tinha
 * sido chamado. A devolução explícita não valia nada: o próximo "oi" do cliente a
 * desfazia.
 *
 * ## A régua
 *
 * Toda devolução ao automático (`devolverAtendimentoAoAgente`) grava a marca
 * `metadata.ia_retomada` na conversa. Enquanto a marca existir E a conversa não
 * tiver passado para humano de novo (`last_handoff_at` nulo — a própria devolução
 * o limpa, e a passagem o grava) E houver IA no ar para o número
 * (`lerQualificacaoDaIA`, a régua do motor), o worker GUARDA o pedido de
 * distribuição em vez de entregar.
 *
 * Não há prazo: quem decide que a conversa precisa de gente é a IA (a passagem)
 * ou uma pessoa (Assumir/Transferir) — nunca o relógio. É a diferença para a
 * opção "Esperar a IA qualificar" do número (#3966), que tem prazo máximo e vale
 * para toda conversa nova; esta vale só para a conversa que alguém JÁ devolveu.
 *
 * ## Por que reagendar, e não descartar
 *
 * A passagem para humano nem sempre pede distribuição por conta própria: a do
 * motor nativo só pede no número que ligou a espera da #3966 (gatilho
 * `trg_routing_assignment_changed`). Descartar o pedido deixaria a conversa
 * passada para humano sem ninguém, até o cliente escrever de novo. Então o pedido
 * é reagendado a cada `INTERVALO_DA_RETOMADA_MS`: na primeira rodada depois da
 * passagem, `last_handoff_at` está gravado, a marca deixa de valer e a conversa é
 * distribuída normalmente — para o setor que a passagem escolheu.
 *
 * ## O que NÃO muda
 *
 *  - modo manual: não há distribuição automática, a marca não é lida;
 *  - destino padrão do número ("direto para uma pessoa", #2331): entrega como sempre;
 *  - conversa com dono: o worker já sai antes (`already_assigned`);
 *  - número sem IA no ar, IA pausada ou calada: distribui (falha ABERTA, como a #3966).
 */

/** A chave em `conversations.metadata`. */
export const CHAVE_DA_RETOMADA_DA_IA = "ia_retomada";

/** De quanto em quanto tempo o pedido guardado é reavaliado. */
export const INTERVALO_DA_RETOMADA_MS = 5 * 60_000;

export type QuemDevolveu = "pessoa" | "automatica";

export interface MarcaDeRetomada {
  /** Instante ISO da devolução. */
  em: string;
  por: QuemDevolveu;
}

/** A marca que a devolução grava. */
export function marcaDeRetomada(por: QuemDevolveu, agora: Date): MarcaDeRetomada {
  return { em: agora.toISOString(), por };
}

/** Lê a marca sem confiar na forma do `metadata` (jsonb livre). */
export function lerMarcaDeRetomada(metadata: unknown): MarcaDeRetomada | null {
  if (!metadata || typeof metadata !== "object") return null;
  const bruta = (metadata as Record<string, unknown>)[CHAVE_DA_RETOMADA_DA_IA];
  if (!bruta || typeof bruta !== "object") return null;
  const { em, por } = bruta as Record<string, unknown>;
  if (typeof em !== "string" || !Number.isFinite(Date.parse(em))) return null;
  if (por !== "pessoa" && por !== "automatica") return null;
  return { em, por };
}

export interface EntradaDaRetomada {
  metadata: unknown;
  /** `conversations.last_handoff_at`: gravado = a conversa passou para humano depois da devolução. */
  lastHandoffAt: string | null;
  /** A IA está no ar para este número e livre para atender (`lerQualificacaoDaIA`). */
  iaAtendendo: boolean;
  agora: Date;
}

/**
 * Até quando o pedido de distribuição fica guardado (ISO), ou `null` = distribuir
 * pelo caminho de sempre.
 */
export function esperaPelaRetomada(e: EntradaDaRetomada): string | null {
  if (!lerMarcaDeRetomada(e.metadata)) return null;
  if (e.lastHandoffAt !== null) return null;
  if (!e.iaAtendendo) return null;
  return new Date(e.agora.getTime() + INTERVALO_DA_RETOMADA_MS).toISOString();
}
