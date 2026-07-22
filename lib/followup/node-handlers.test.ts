import { describe, it, expect } from "vitest";

import {
  BACKOFF_MS,
  processNode,
  resolveWaitPhase,
  selectEdge,
  type EnrollmentRow,
  type LeadFacts,
} from "./node-handlers";
import type { FlowEdge, FlowNode } from "./graph-schema";

const NOW = new Date("2026-07-21T12:00:00.000Z");
const clock = () => NOW;

function enrollment(overrides: Partial<EnrollmentRow> = {}): EnrollmentRow {
  return {
    id: "enr-1",
    organization_id: "org-1",
    pointer_id: "ptr-1",
    version_id: "ver-1",
    contact_id: "contact-1",
    conversation_id: null,
    current_node_id: "n1",
    status: "active",
    next_eval_at: NOW.toISOString(),
    claimed_until: null,
    attempts: 0,
    max_attempts: 5,
    last_error: null,
    steps_taken: 3,
    outcome: null,
    cancel_reason: null,
    started_at: NOW.toISOString(),
    completed_at: null,
    updated_at: NOW.toISOString(),
    ...overrides,
  };
}

function lead(overrides: Partial<LeadFacts> = {}): LeadFacts {
  return { lead_stage: null, tags: [], steps_taken: 0, last_outcome: null, ...overrides };
}

function edge(overrides: Partial<FlowEdge> & Pick<FlowEdge, "source" | "target" | "condition">): FlowEdge {
  return { id: `${overrides.source}->${overrides.target}`, priority: 0, ...overrides };
}

describe("BACKOFF_MS", () => {
  it("is the exact 5-slot ladder from 30s to 1h", () => {
    expect(BACKOFF_MS).toEqual([30_000, 60_000, 300_000, 900_000, 3_600_000]);
  });
});

describe("selectEdge", () => {
  const edges: FlowEdge[] = [
    edge({ source: "n1", target: "low", condition: { type: "always" }, priority: 0 }),
    edge({ source: "n1", target: "high", condition: { type: "always" }, priority: 10 }),
    edge({ source: "n1", target: "hot", condition: { type: "class_match", value: "hot" }, priority: 5 }),
    edge({ source: "n1", target: "yes", condition: { type: "cond_result", value: true }, priority: 5 }),
    edge({ source: "other", target: "x", condition: { type: "always" }, priority: 99 }),
  ];

  it("picks highest-priority 'always' edge when asked for always", () => {
    const picked = selectEdge(edges, "n1", { type: "always" });
    expect(picked?.target).toBe("high");
  });

  it("picks the exact class_match edge over the always fallback", () => {
    const picked = selectEdge(edges, "n1", { type: "class_match", value: "hot" });
    expect(picked?.target).toBe("hot");
  });

  it("falls back to 'always' when no class_match edge matches the value", () => {
    const picked = selectEdge(edges, "n1", { type: "class_match", value: "cold" });
    expect(picked?.target).toBe("high");
  });

  it("picks the exact cond_result edge over the always fallback", () => {
    const picked = selectEdge(edges, "n1", { type: "cond_result", value: true });
    expect(picked?.target).toBe("yes");
  });

  it("falls back to 'always' when cond_result value doesn't match", () => {
    const picked = selectEdge(edges, "n1", { type: "cond_result", value: false });
    expect(picked?.target).toBe("high");
  });

  it("returns null when the node has no outbound edges at all", () => {
    expect(selectEdge(edges, "ghost", { type: "always" })).toBeNull();
  });

  it("returns null when no exact match and no always fallback exists", () => {
    const onlyClassMatch: FlowEdge[] = [
      edge({ source: "n1", target: "hot", condition: { type: "class_match", value: "hot" } }),
    ];
    expect(selectEdge(onlyClassMatch, "n1", { type: "class_match", value: "cold" })).toBeNull();
  });
});

describe("resolveWaitPhase", () => {
  it("false on first entry (no prior-step event for this node)", () => {
    expect(resolveWaitPhase([], "wait1", 5)).toBe(false);
  });

  it("true once the prior-step event for this node exists", () => {
    const events = [{ node_id: "wait1", idempotency_key: "wait1:4" }];
    expect(resolveWaitPhase(events, "wait1", 5)).toBe(true);
  });

  it("ignores prior-step events belonging to a different node", () => {
    const events = [{ node_id: "other", idempotency_key: "wait1:4" }];
    expect(resolveWaitPhase(events, "wait1", 5)).toBe(false);
  });
});

describe("processNode — trigger", () => {
  it("advances via the 'always' edge immediately", () => {
    const node: FlowNode = { id: "t1", type: "trigger", label: "Start", position: { x: 0, y: 0 }, config: {} };
    const edges = [edge({ source: "t1", target: "n2", condition: { type: "always" } })];
    const result = processNode({ node, edges, enrollment: enrollment(), lead: lead(), clock });
    expect(result).toEqual({ kind: "advance", next_node_id: "n2", next_eval_at: NOW });
  });

  it("fails when the trigger has no outbound edge", () => {
    const node: FlowNode = { id: "t1", type: "trigger", label: "Start", position: { x: 0, y: 0 }, config: {} };
    const result = processNode({ node, edges: [], enrollment: enrollment(), lead: lead(), clock });
    expect(result.kind).toBe("fail");
  });
});

describe("processNode — wait (fixed)", () => {
  const node: FlowNode = {
    id: "w1",
    type: "wait",
    label: "Wait 5min",
    position: { x: 0, y: 0 },
    config: { mode: "fixed", duration_ms: 300_000 },
  };
  const edges = [edge({ source: "w1", target: "n2", condition: { type: "always" } })];

  it("first entry: schedules next_eval_at = now + duration_ms, stays put", () => {
    const result = processNode({ node, edges, enrollment: enrollment(), lead: lead(), clock, waitElapsed: false });
    expect(result).toEqual({ kind: "wait", next_eval_at: new Date(NOW.getTime() + 300_000) });
  });

  it("elapsed: advances via the 'always' edge", () => {
    const result = processNode({ node, edges, enrollment: enrollment(), lead: lead(), clock, waitElapsed: true });
    expect(result).toEqual({ kind: "advance", next_node_id: "n2", next_eval_at: NOW });
  });

  it("elapsed but no outbound edge: fails", () => {
    const result = processNode({ node, edges: [], enrollment: enrollment(), lead: lead(), clock, waitElapsed: true });
    expect(result.kind).toBe("fail");
  });
});

describe("processNode — wait (smart, onda 5 clamp: treated as fixed at max_ms)", () => {
  const node: FlowNode = {
    id: "w2",
    type: "wait",
    label: "Wait smart",
    position: { x: 0, y: 0 },
    config: { mode: "smart", min_ms: 600_000, max_ms: 1_800_000 },
  };

  it("first entry uses max_ms as the duration", () => {
    const result = processNode({ node, edges: [], enrollment: enrollment(), lead: lead(), clock, waitElapsed: false });
    expect(result).toEqual({ kind: "wait", next_eval_at: new Date(NOW.getTime() + 1_800_000) });
  });
});

describe("processNode — condition", () => {
  const edges = [
    edge({ source: "c1", target: "yes", condition: { type: "cond_result", value: true } }),
    edge({ source: "c1", target: "no", condition: { type: "cond_result", value: false } }),
  ];

  function conditionNode(config: Extract<FlowNode, { type: "condition" }>["config"]): FlowNode {
    return { id: "c1", type: "condition", label: "Check", position: { x: 0, y: 0 }, config };
  }

  it("eq true routes to the true edge", () => {
    const node = conditionNode({ combinator: "and", checks: [{ field: "lead_stage", op: "eq", value: "hot" }] });
    const result = processNode({ node, edges, enrollment: enrollment(), lead: lead({ lead_stage: "hot" }), clock });
    expect(result).toMatchObject({ kind: "advance", next_node_id: "yes" });
  });

  it("neq false routes to the false edge", () => {
    const node = conditionNode({ combinator: "and", checks: [{ field: "lead_stage", op: "neq", value: "hot" }] });
    const result = processNode({ node, edges, enrollment: enrollment(), lead: lead({ lead_stage: "hot" }), clock });
    expect(result).toMatchObject({ kind: "advance", next_node_id: "no" });
  });

  it("gte on steps_taken", () => {
    const node = conditionNode({ combinator: "and", checks: [{ field: "steps_taken", op: "gte", value: 3 }] });
    const result = processNode({ node, edges, enrollment: enrollment(), lead: lead({ steps_taken: 3 }), clock });
    expect(result).toMatchObject({ kind: "advance", next_node_id: "yes" });
  });

  it("lte on steps_taken", () => {
    const node = conditionNode({ combinator: "and", checks: [{ field: "steps_taken", op: "lte", value: 2 }] });
    const result = processNode({ node, edges, enrollment: enrollment(), lead: lead({ steps_taken: 3 }), clock });
    expect(result).toMatchObject({ kind: "advance", next_node_id: "no" });
  });

  it("contains on tag (array membership)", () => {
    const node = conditionNode({ combinator: "and", checks: [{ field: "tag", op: "contains", value: "vip" }] });
    const result = processNode({ node, edges, enrollment: enrollment(), lead: lead({ tags: ["vip", "b2b"] }), clock });
    expect(result).toMatchObject({ kind: "advance", next_node_id: "yes" });
  });

  it("contains on last_outcome substring", () => {
    const node = conditionNode({ combinator: "and", checks: [{ field: "last_outcome", op: "contains", value: "hot" }] });
    const result = processNode({
      node,
      edges,
      enrollment: enrollment(),
      lead: lead({ last_outcome: "classified_hot" }),
      clock,
    });
    expect(result).toMatchObject({ kind: "advance", next_node_id: "yes" });
  });

  it("combinator 'and': all checks must pass", () => {
    const node = conditionNode({
      combinator: "and",
      checks: [
        { field: "lead_stage", op: "eq", value: "hot" },
        { field: "steps_taken", op: "gte", value: 10 },
      ],
    });
    const result = processNode({
      node,
      edges,
      enrollment: enrollment(),
      lead: lead({ lead_stage: "hot", steps_taken: 1 }),
      clock,
    });
    expect(result).toMatchObject({ kind: "advance", next_node_id: "no" });
  });

  it("combinator 'or': any check passing is enough", () => {
    const node = conditionNode({
      combinator: "or",
      checks: [
        { field: "lead_stage", op: "eq", value: "cold" },
        { field: "steps_taken", op: "gte", value: 1 },
      ],
    });
    const result = processNode({
      node,
      edges,
      enrollment: enrollment(),
      lead: lead({ lead_stage: "hot", steps_taken: 1 }),
      clock,
    });
    expect(result).toMatchObject({ kind: "advance", next_node_id: "yes" });
  });

  it("fails when no edge matches the evaluated result", () => {
    const node = conditionNode({ combinator: "and", checks: [{ field: "lead_stage", op: "eq", value: "hot" }] });
    const result = processNode({
      node,
      edges: [edge({ source: "c1", target: "yes", condition: { type: "cond_result", value: true } })],
      enrollment: enrollment(),
      lead: lead({ lead_stage: "cold" }),
      clock,
    });
    expect(result.kind).toBe("fail");
  });
});

describe("processNode — ai_classify / action", () => {
  it("ai_classify enqueues a classify turn and wakes to waiting_reply", () => {
    const node: FlowNode = {
      id: "ac1",
      type: "ai_classify",
      label: "Classify",
      position: { x: 0, y: 0 },
      config: { classes: ["hot", "cold"], grace_timeout_ms: 900_000, target: "last_reply" },
    };
    const result = processNode({ node, edges: [], enrollment: enrollment(), lead: lead(), clock });
    expect(result).toEqual({ kind: "enqueue_turn", purpose: "classify", wake_status: "waiting_reply" });
  });

  it("ai_classify re-entry (grace elapsed, no completed classify): routes via 'no_reply' class_match edge without enqueuing another turn", () => {
    const node: FlowNode = {
      id: "ac1",
      type: "ai_classify",
      label: "Classify",
      position: { x: 0, y: 0 },
      config: { classes: ["hot", "cold"], grace_timeout_ms: 900_000, target: "last_reply" },
    };
    const edges = [
      edge({ source: "ac1", target: "hot-node", condition: { type: "class_match", value: "hot" } }),
      edge({ source: "ac1", target: "no-reply-node", condition: { type: "class_match", value: "no_reply" } }),
    ];
    const result = processNode({ node, edges, enrollment: enrollment(), lead: lead(), clock, waitElapsed: true });
    expect(result).toEqual({ kind: "advance", next_node_id: "no-reply-node", next_eval_at: NOW });
  });

  it("ai_classify re-entry without an explicit no_reply edge falls back to the 'always' edge", () => {
    const node: FlowNode = {
      id: "ac1",
      type: "ai_classify",
      label: "Classify",
      position: { x: 0, y: 0 },
      config: { classes: ["hot", "cold"], grace_timeout_ms: 900_000, target: "last_reply" },
    };
    const edges = [
      edge({ source: "ac1", target: "hot-node", condition: { type: "class_match", value: "hot" } }),
      edge({ source: "ac1", target: "fallback-node", condition: { type: "always" } }),
    ];
    const result = processNode({ node, edges, enrollment: enrollment(), lead: lead(), clock, waitElapsed: true });
    expect(result).toEqual({ kind: "advance", next_node_id: "fallback-node", next_eval_at: NOW });
  });

  it("ai_classify re-entry with neither a no_reply nor an always edge: fails", () => {
    const node: FlowNode = {
      id: "ac1",
      type: "ai_classify",
      label: "Classify",
      position: { x: 0, y: 0 },
      config: { classes: ["hot", "cold"], grace_timeout_ms: 900_000, target: "last_reply" },
    };
    const edges = [edge({ source: "ac1", target: "hot-node", condition: { type: "class_match", value: "hot" } })];
    const result = processNode({ node, edges, enrollment: enrollment(), lead: lead(), clock, waitElapsed: true });
    expect(result.kind).toBe("fail");
  });

  it("action enqueues a send_message turn and keeps status active", () => {
    const node: FlowNode = {
      id: "a1",
      type: "action",
      label: "Send",
      position: { x: 0, y: 0 },
      config: { mode: "ai_message", prompt_hint: "lembre o lead" },
    };
    const result = processNode({ node, edges: [], enrollment: enrollment(), lead: lead(), clock });
    expect(result).toEqual({ kind: "enqueue_turn", purpose: "send_message", wake_status: "active" });
  });
});

describe("processNode — end", () => {
  it("converted maps straight through", () => {
    const node: FlowNode = { id: "e1", type: "end", label: "Done", position: { x: 0, y: 0 }, config: { outcome: "converted" } };
    const result = processNode({ node, edges: [], enrollment: enrollment(), lead: lead(), clock });
    expect(result).toEqual({ kind: "complete", outcome: "converted" });
  });

  it("exhausted maps straight through", () => {
    const node: FlowNode = { id: "e1", type: "end", label: "Done", position: { x: 0, y: 0 }, config: { outcome: "exhausted" } };
    const result = processNode({ node, edges: [], enrollment: enrollment(), lead: lead(), clock });
    expect(result).toEqual({ kind: "complete", outcome: "exhausted" });
  });

  it("custom maps to null outcome + cancel_reason = note", () => {
    const node: FlowNode = {
      id: "e1",
      type: "end",
      label: "Done",
      position: { x: 0, y: 0 },
      config: { outcome: "custom", note: "lead pediu pra sair" },
    };
    const result = processNode({ node, edges: [], enrollment: enrollment(), lead: lead(), clock });
    expect(result).toEqual({ kind: "complete", outcome: null, cancel_reason: "lead pediu pra sair" });
  });
});
