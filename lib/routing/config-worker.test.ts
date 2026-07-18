import { describe, expect, it } from "vitest";

import { decideRouting, type RoutingCandidate } from "./decide";
import { isAttendantEligible } from "./eligibility";
import { routingConfigSchema } from "@/lib/schemas/routing";

/**
 * G5-04 acceptance 4: quando o manager altera modo/capacidade pelo painel, o
 * worker de roteamento LÊ a config nova e se comporta diferente.
 *
 * O PATCH /settings/routing persiste exatamente `routingConfigSchema.parse(body)`
 * em organizations.settings.routing; o worker (worker.ts) lê o MESMO shape via
 * `routingConfigSchema.parse(settings.routing)` e a capacidade via
 * `isAttendantEligible`. Este teste percorre esse caminho puro (config → decisão)
 * para provar que a mudança do painel muda o resultado, sem Postgres vivo.
 */

const NOW = new Date("2026-07-18T15:00:00Z");
const cand = (userId: string): RoutingCandidate => ({ userId, currentLoad: 0, lastAssignedAt: null });

/** Simula o worker resolvendo o modo a partir do que o painel gravou. */
function workerDecisionForMode(mode: string, eligibles: RoutingCandidate[]) {
  const config = routingConfigSchema.parse({ mode });
  return decideRouting({ mode: config.mode, alreadyAssigned: false, eligibles, config, attempts: 0, now: NOW });
}

describe("config do painel → comportamento do worker (G5-04 acceptance 4)", () => {
  it("mode='manual' (default do painel) ⇒ worker NÃO atribui", () => {
    const action = workerDecisionForMode("manual", [cand("agent-a")]);
    expect(action).toEqual({ kind: "skip", reason: "manual_mode" });
  });

  it("manager troca para 'round_robin' ⇒ worker passa a atribuir", () => {
    const action = workerDecisionForMode("round_robin", [cand("agent-a")]);
    expect(action).toEqual({ kind: "assign", userId: "agent-a" });
  });

  it("capacidade do painel manda: atendente cheio fica inelegível ⇒ worker não atribui a ele", () => {
    // capacity=2 e carga=1 ⇒ com folga (elegível).
    expect(isAttendantEligible({ isAvailable: true, capacity: 2, currentLoad: 1 }, NOW)).toBe(true);
    // manager REDUZ capacity para 1 ⇒ mesma carga=1 agora enche ⇒ inelegível.
    expect(isAttendantEligible({ isAvailable: true, capacity: 1, currentLoad: 1 }, NOW)).toBe(false);

    // Sem elegível, o worker reenfileira (backoff da config) em vez de atribuir.
    const action = workerDecisionForMode("round_robin", []);
    expect(action.kind).toBe("requeue");
  });

  it("knobs do painel (backoff) alimentam o requeue do worker — não são hardcode", () => {
    const config = routingConfigSchema.parse({ mode: "round_robin", backoff_seconds: 120 });
    const action = decideRouting({ mode: "round_robin", alreadyAssigned: false, eligibles: [], config, attempts: 0, now: NOW });
    expect(action.kind).toBe("requeue");
    if (action.kind === "requeue") {
      expect(new Date(action.nextAttemptAt).getTime()).toBe(NOW.getTime() + 120_000);
    }
  });
});
