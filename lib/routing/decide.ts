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

import type { MotivoDoCaso } from "./caso-da-conversa";

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
  /**
   * Destino padrão do NÚMERO (#2331). Quando o canal tem um atendente de
   * destino padrão configurado, a conversa vai DIRETO para ele, antes de
   * qualquer distribuição por modo — é o "entregar tudo a uma pessoa
   * específica" da tela por número. `null`/ausente = sem destino padrão; o
   * modo decide normalmente.
   */
  defaultAssigneeUserId?: string | null;
  /** attempts atual do event_log (antes deste processamento). */
  attempts: number;
  now: Date;
  /**
   * O CASO DESTA CONVERSA TIRA ELA DA FILA? (#3717) — `null`/ausente = não.
   *
   * Quem responde a pergunta é `motivoParaNaoRotear` (`./caso-da-conversa`), a
   * partir do caso mais recente lido pelo worker. Vem como argumento pronto, e
   * não como a linha do caso, por dois motivos: a decisão continua sem banco (as
   * regras do acceptance test seguem testáveis por unit) e existe UM lugar — o
   * módulo da regra — onde o vocabulário de `agent_cases.status` é lido.
   */
  motivoDoCaso?: MotivoDoCaso | null;
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

  // O CASO MANDA ANTES DA FILA (#3717). Se o caso mais recente da conversa não
  // pede uma pessoa agora — `awaiting_lead` (a bola está com o cliente) ou um
  // caso já concluído sem entrada nova do cliente —, a conversa sai da fila
  // mesmo estando `open`/`ai_handling` e sem dono. Vem DEPOIS da idempotência
  // (conversa com dono não é assunto da fila) e ANTES do destino padrão do
  // número (#2331): aquele decide QUEM recebe quando há distribuição; este
  // decide SE há distribuição. Um caso concluído não vira trabalho de ninguém
  // só porque o número entrega tudo a uma pessoa específica.
  if (input.motivoDoCaso) return { kind: "skip", reason: input.motivoDoCaso };

  // Destino padrão do NÚMERO (#2331): vence o modo. O canal que entrega tudo a
  // uma pessoa específica recebe mesmo quando o modo da organização é manual (o
  // caso "sem IA, direto para o fulano") ou rodízio.
  if (input.defaultAssigneeUserId) return { kind: "assign", userId: input.defaultAssigneeUserId };

  // Modo manual (acceptance 5): worker não roteia.
  if (input.mode === "manual") return { kind: "skip", reason: "manual_mode" };

  // Fora da lista de ROUTING_MODES (defensivo): roteia só o que a tela deixa
  // escolher. 'load' deixou de ser no-op e passou a rotear pela issue #1539.
  if (input.mode !== "round_robin" && input.mode !== "load") {
    return { kind: "skip", reason: `unsupported_mode:${input.mode}` };
  }

  const picked =
    input.mode === "load" ? selectByLoad(input.eligibles) : selectRoundRobin(input.eligibles);
  if (picked) return { kind: "assign", userId: picked };

  // Sem elegível (acceptance 4): re-agenda com backoff da config (não hardcoded).
  const attempts = Math.min(input.attempts + 1, input.config.max_retries);
  const slow = input.attempts >= input.config.max_retries;
  const seconds = slow ? Math.max(900, input.config.backoff_seconds) : input.config.backoff_seconds;
  const nextAttemptAt = new Date(input.now.getTime() + seconds * 1000).toISOString();
  return { kind: "requeue", nextAttemptAt, attempts };
}

/**
 * A regra POR NÚMERO, como o worker a lê de `channel_routing_policies` (#2331).
 * `null` no campo = o número não tem regra própria naquele eixo.
 */
export interface RegraDoNumero {
  distribution_mode: RoutingMode | null;
  default_assignee_user_id: string | null;
}

export interface RoteamentoEfetivo {
  mode: RoutingMode;
  defaultAssigneeUserId: string | null;
}

/**
 * Resolve o que VALE para um número a partir do que vale para a organização.
 *
 * É o coração da issue #2331: um canal com regra própria NÃO usa a regra da
 * organização; um canal SEM regra cai no comportamento da organização — e é
 * exatamente o que não muda para quem já instalou (a policy nasce com os dois
 * campos nulos).
 *
 * Pura de propósito: o worker (I/O) chama isto e os testes provam o
 * isolamento canal × organização sem Postgres vivo.
 */
export function resolverRoteamentoPorNumero(
  daOrganizacao: RoutingConfig,
  regraDoNumero: RegraDoNumero | null | undefined,
): RoteamentoEfetivo {
  return {
    mode: regraDoNumero?.distribution_mode ?? daOrganizacao.mode,
    defaultAssigneeUserId: regraDoNumero?.default_assignee_user_id ?? null,
  };
}
