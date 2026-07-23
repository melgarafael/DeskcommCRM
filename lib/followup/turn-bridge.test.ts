import { describe, it, expect, vi } from "vitest";

import { clampProposedAt, completeTurnForEnrollment, type TurnBridgeAdminClient } from "./turn-bridge";
import type { EnrollmentRow } from "./node-handlers";
import type { FlowGraph } from "./graph-schema";

const NOW = new Date("2026-07-22T12:00:00.000Z");
const clock = () => NOW;

function enrollment(overrides: Partial<EnrollmentRow> = {}): EnrollmentRow {
  return {
    id: "enr-1",
    organization_id: "org-1",
    pointer_id: "ptr-1",
    version_id: "ver-1",
    contact_id: "contact-1",
    conversation_id: null,
    current_node_id: "a1",
    status: "active",
    next_eval_at: NOW.toISOString(),
    claimed_until: NOW.toISOString(),
    attempts: 0,
    max_attempts: 5,
    last_error: null,
    steps_taken: 4,
    outcome: null,
    cancel_reason: null,
    started_at: NOW.toISOString(),
    completed_at: null,
    updated_at: NOW.toISOString(),
    ...overrides,
  };
}

const ACTION_GRAPH: FlowGraph = {
  nodes: [
    { id: "a1", type: "action", label: "Send", position: { x: 0, y: 0 }, config: { mode: "ai_message", prompt_hint: "oi" } },
    { id: "e1", type: "end", label: "Done", position: { x: 0, y: 0 }, config: { outcome: "converted" } },
  ],
  edges: [{ id: "a1-e1", source: "a1", target: "e1", priority: 0, condition: { type: "always" } }],
};

const CLASSIFY_GRAPH: FlowGraph = {
  nodes: [
    {
      id: "ac1",
      type: "ai_classify",
      label: "Classify",
      position: { x: 0, y: 0 },
      config: { classes: ["hot", "cold"], grace_timeout_ms: 900_000, target: "last_reply" },
    },
    { id: "hot-node", type: "end", label: "Hot", position: { x: 0, y: 0 }, config: { outcome: "converted" } },
    { id: "fallback-node", type: "end", label: "Fallback", position: { x: 0, y: 0 }, config: { outcome: "exhausted" } },
  ],
  edges: [
    { id: "ac1-hot", source: "ac1", target: "hot-node", priority: 5, condition: { type: "class_match", value: "hot" } },
    { id: "ac1-fallback", source: "ac1", target: "fallback-node", priority: 0, condition: { type: "always" } },
  ],
};

const SMART_WAIT_GRAPH: FlowGraph = {
  nodes: [
    {
      id: "w1",
      type: "wait",
      label: "Wait smart",
      position: { x: 0, y: 0 },
      config: { mode: "smart", min_ms: 600_000, max_ms: 1_800_000 },
    },
    { id: "e1", type: "end", label: "Done", position: { x: 0, y: 0 }, config: { outcome: "converted" } },
  ],
  edges: [{ id: "w1-e1", source: "w1", target: "e1", priority: 0, condition: { type: "always" } }],
};

/** Fake in-memory TurnBridgeAdminClient — mirrors the pg-backed adapter's contract without a DB. */
function fakeDb(opts: {
  enrollment: EnrollmentRow | null;
  graph: FlowGraph | null;
  existingEvents?: Set<string>;
}): { db: TurnBridgeAdminClient; updateEnrollment: ReturnType<typeof vi.fn>; insertEnrollmentEvent: ReturnType<typeof vi.fn> } {
  const eventKeys = opts.existingEvents ?? new Set<string>();
  const updateEnrollment = vi.fn(async () => {});
  const insertEnrollmentEvent = vi.fn(async (event: { idempotency_key: string }) => {
    if (eventKeys.has(event.idempotency_key)) return { inserted: false };
    eventKeys.add(event.idempotency_key);
    return { inserted: true };
  });
  const db: TurnBridgeAdminClient = {
    claimDueEnrollments: async () => [],
    loadEnrollmentById: async () => opts.enrollment,
    loadFlowGraph: async () => opts.graph,
    loadLeadFacts: async () => ({ lead_stage: null, tags: [] }),
    loadEnrollmentEvents: async () => [],
    insertEnrollmentEvent,
    updateEnrollment,
    loadFlowPointerName: async () => null,
    insertDeadInboxItem: async () => {},
  };
  return { db, updateEnrollment, insertEnrollmentEvent };
}

describe("clampProposedAt", () => {
  it("clamps a proposal below min_ms up to now + min_ms", () => {
    const proposed = new Date(NOW.getTime() + 60_000).toISOString(); // 1min — abaixo do min de 10min
    const result = clampProposedAt(proposed, NOW, 600_000, 1_800_000);
    expect(result).toEqual(new Date(NOW.getTime() + 600_000));
  });

  it("clamps a proposal above max_ms down to now + max_ms", () => {
    const proposed = new Date(NOW.getTime() + 10_000_000).toISOString(); // muito além do max de 30min
    const result = clampProposedAt(proposed, NOW, 600_000, 1_800_000);
    expect(result).toEqual(new Date(NOW.getTime() + 1_800_000));
  });

  it("keeps a proposal already inside the range untouched", () => {
    const proposed = new Date(NOW.getTime() + 900_000).toISOString(); // 15min — dentro de [10,30]
    const result = clampProposedAt(proposed, NOW, 600_000, 1_800_000);
    expect(result).toEqual(new Date(NOW.getTime() + 900_000));
  });

  it("degrades an unparseable instant to min_ms (safe side)", () => {
    const result = clampProposedAt("not-a-date", NOW, 600_000, 1_800_000);
    expect(result).toEqual(new Date(NOW.getTime() + 600_000));
  });
});

describe("completeTurnForEnrollment — 'sent' (action)", () => {
  it("advances to the next node via the 'always' edge and writes an idempotent 'action_sent' event", async () => {
    const { db, updateEnrollment, insertEnrollmentEvent } = fakeDb({ enrollment: enrollment(), graph: ACTION_GRAPH });

    await completeTurnForEnrollment(db, "org-1", "enr-1", "a1", { kind: "sent" }, clock);

    expect(insertEnrollmentEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: "action_sent", idempotency_key: "a1:4" }),
    );
    expect(updateEnrollment).toHaveBeenCalledWith(
      "enr-1",
      "org-1",
      expect.objectContaining({ current_node_id: "e1", status: "active", steps_taken: 5 }),
    );
  });

  it("double completion (same steps_taken) is idempotent — 2nd call is a no-op", async () => {
    const { db, updateEnrollment } = fakeDb({
      enrollment: enrollment(),
      graph: ACTION_GRAPH,
      existingEvents: new Set(["a1:4"]),
    });

    await completeTurnForEnrollment(db, "org-1", "enr-1", "a1", { kind: "sent" }, clock);

    expect(updateEnrollment).not.toHaveBeenCalled();
  });

  it("throws when the node isn't an 'action' node", async () => {
    const { db } = fakeDb({ enrollment: enrollment({ current_node_id: "ac1" }), graph: CLASSIFY_GRAPH });
    await expect(completeTurnForEnrollment(db, "org-1", "enr-1", "ac1", { kind: "sent" }, clock)).rejects.toThrow();
  });
});

describe("completeTurnForEnrollment — 'classified' (ai_classify)", () => {
  it("routes to the exact class_match edge", async () => {
    const { db, updateEnrollment } = fakeDb({ enrollment: enrollment({ current_node_id: "ac1" }), graph: CLASSIFY_GRAPH });

    await completeTurnForEnrollment(db, "org-1", "enr-1", "ac1", { kind: "classified", class: "hot" }, clock);

    expect(updateEnrollment).toHaveBeenCalledWith(
      "enr-1",
      "org-1",
      expect.objectContaining({ current_node_id: "hot-node" }),
    );
  });

  it("routes an unknown class through the 'always' fallback edge", async () => {
    const { db, updateEnrollment } = fakeDb({ enrollment: enrollment({ current_node_id: "ac1" }), graph: CLASSIFY_GRAPH });

    await completeTurnForEnrollment(db, "org-1", "enr-1", "ac1", { kind: "classified", class: "mystery" }, clock);

    expect(updateEnrollment).toHaveBeenCalledWith(
      "enr-1",
      "org-1",
      expect.objectContaining({ current_node_id: "fallback-node" }),
    );
  });
});

describe("completeTurnForEnrollment — 'timing' (wait smart)", () => {
  it("clamps the proposed instant and stays on the same wait node", async () => {
    const { db, updateEnrollment } = fakeDb({ enrollment: enrollment({ current_node_id: "w1" }), graph: SMART_WAIT_GRAPH });
    const proposedAt = new Date(NOW.getTime() + 10_000_000).toISOString(); // acima do max

    await completeTurnForEnrollment(db, "org-1", "enr-1", "w1", { kind: "timing", proposed_at: proposedAt }, clock);

    expect(updateEnrollment).toHaveBeenCalledWith(
      "enr-1",
      "org-1",
      expect.objectContaining({
        current_node_id: "w1",
        next_eval_at: new Date(NOW.getTime() + 1_800_000).toISOString(),
      }),
    );
  });
});

describe("completeTurnForEnrollment — obsolescência", () => {
  it("no-ops when the enrollment already moved past the node the turn ran for", async () => {
    const { db, updateEnrollment } = fakeDb({ enrollment: enrollment({ current_node_id: "e1" }), graph: ACTION_GRAPH });

    await completeTurnForEnrollment(db, "org-1", "enr-1", "a1", { kind: "sent" }, clock);

    expect(updateEnrollment).not.toHaveBeenCalled();
  });

  it("no-ops when the enrollment is already terminal", async () => {
    const { db, updateEnrollment } = fakeDb({ enrollment: enrollment({ status: "dead" }), graph: ACTION_GRAPH });

    await completeTurnForEnrollment(db, "org-1", "enr-1", "a1", { kind: "sent" }, clock);

    expect(updateEnrollment).not.toHaveBeenCalled();
  });

  it("no-ops silently when the enrollment no longer exists", async () => {
    const { db, updateEnrollment } = fakeDb({ enrollment: null, graph: ACTION_GRAPH });

    await completeTurnForEnrollment(db, "org-1", "enr-1", "a1", { kind: "sent" }, clock);

    expect(updateEnrollment).not.toHaveBeenCalled();
  });
});
