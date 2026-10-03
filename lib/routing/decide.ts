/**
 * Decisão PURA de roteamento (G5-02 — AT-03, spec 13 §5).
 *
 * Toda a lógica de branch do worker vive aqui, sem DB e sem relógio implícito
 * (o `now` é injetado). O worker (lib/routing/worker.ts) é só a casca de I/O:
 * junta os inputs (mode, conversa, elegíveis, config), chama `decideRouting` e
 * executa a Action. Isso mantém as 5 regras do acceptance testáveis por unit
 * sem precisar de um Postgres vivo.
 */
import type { Json } from "@/lib/database.types";
import type { RoutingConfig, RoutingMode } from "@/lib/schemas/routing";

/** Um atendente já FILTRADO por elegibilidade (§5: disponível ∧ horário ∧ folga). */
export interface RoutingCandidate {
  userId: string;
  /** Fato persistido relido no claim, sem confundir com defaults do parser. */
  scheduleSnapshot?: Json;
  /**
   * Conversas abertas atribuídas (carga atual). É a CHAVE do modo `load`
   * (#1539) e o desempate secundário do modo round_robin.
   */
  currentLoad: number;
  /** Epoch ms da última atribuição recebida; null = nunca (prioridade máxima no rodízio). */
  lastAssignedAt: number | null;
}

export type RoutingAction =
  | { kind: "assign"; userId: string }
  /** Marca o evento consumido sem atribuir (já tem dono, modo manual, modo não suportado). */
  | { kind: "skip"; reason: string }
  /** Sem elegível: reenfileira com backoff (fica na fila até haver quem atenda). */
  | { kind: "requeue"; nextAttemptAt: string; attempts: number };

export interface DecideRoutingInput {
  mode: RoutingMode | string;
  /** A conversa já tem dono? true ⇒ replay/corrida ⇒ nunca reatribui (idempotência AT-03). */
  alreadyAssigned: boolean;
  /** Atendentes JÁ elegíveis (o worker aplicou isAttendantEligible). */
  eligibles: RoutingCandidate[];
  config: RoutingConfig;
  /** attempts atual do event_log (antes deste processamento). */
  attempts: number;
  now: Date;
}

/**
 * Rodízio real (não random): entre elegíveis, o que recebeu atribuição há mais
 * tempo (ou nunca) vem primeiro; desempate determinístico por userId. Deriva o
 * "último atribuído" de conversation_assignment_events — sem coluna de estado.
 */
export function selectRoundRobin(eligibles: RoutingCandidate[]): string | null {
  if (eligibles.length === 0) return null;
  const sorted = [...eligibles].sort((a, b) => {
    const la = a.lastAssignedAt ?? -1;
    const lb = b.lastAssignedAt ?? -1;
    if (la !== lb) return la - lb; // mais antigo (ou nunca = -1) primeiro
    return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0;
  });
  return sorted[0]?.userId ?? null;
}

/**
 * Modo `load` (#1539): entre os elegíveis, o de MENOR `currentLoad` leva a
 * conversa. O empate de carga cai no MESMO rodízio do modo round_robin — quem
 * está há mais tempo sem receber vem primeiro —, e o userId fecha o desempate,
 * para o resultado ser determinístico (critério de aceite: cargas 3 e 1 ⇒ a de
 * 1; duas cargas iguais ⇒ a mesma resposta a cada rodada).
 */
export function selectByLoad(eligibles: RoutingCandidate[]): string | null {
  if (eligibles.length === 0) return null;
  const menor = Math.min(...eligibles.map((c) => c.currentLoad));
  return selectRoundRobin(eligibles.filter((c) => c.currentLoad === menor));
}

export function decideRouting(input: DecideRoutingInput): RoutingAction {
  // Idempotência (acceptance 3): conversa que já ganhou dono não é reatribuída.
  if (input.alreadyAssigned) return { kind: "skip", reason: "already_assigned" };

  // Modo manual (acceptance 5): worker não roteia.
  if (input.mode === "manual") return { kind: "skip", reason: "manual_mode" };

  // Fora da lista de ROUTING_MODES (defensivo): roteia só o que a tela deixa
  // escolher. 'load' deixou de ser no-op e passou a rotear pela issue #1539.
  if (input.mode !== "round_robin" && input.mode !== "load") {
    return { kind: "skip", reason: `unsupported_mode:${input.mode}` };
  }

  const picked = input.mode === "load" ? selectByLoad(input.eligibles) : selectRoundRobin(input.eligibles);
  if (picked) return { kind: "assign", userId: picked };

  // Sem elegível (acceptance 4): re-agenda com backoff da config (não hardcoded).
  const attempts = Math.min(input.attempts + 1, input.config.max_retries);
  const slow = input.attempts >= input.config.max_retries;
  const seconds = slow ? Math.max(900, input.config.backoff_seconds) : input.config.backoff_seconds;
  const nextAttemptAt = new Date(input.now.getTime() + seconds * 1000).toISOString();
  return { kind: "requeue", nextAttemptAt, attempts };
}
